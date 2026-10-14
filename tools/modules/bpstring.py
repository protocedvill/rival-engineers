"""Blueprint string tools: decode, encode, list a book, and convert blueprints into the entity-dump
format that cluster.py and tools/render/render.py read.

A blueprint string is "0" + base64(zlib(JSON)). 1.x and 0.17 strings use 8-way directions (0,2,4,6);
2.0 uses 16-way (0,4,8,12). Conversion normalises to 2.0 directions and renames the few entities that
2.0 renamed.

Usage:
  python3 -I tools/modules/bpstring.py decode STRING_FILE [-o out.json]
  python3 -I tools/modules/bpstring.py encode JSON_FILE [-o out.txt]
  python3 -I tools/modules/bpstring.py list STRING_OR_JSON_FILE
  python3 -I tools/modules/bpstring.py to-dump STRING_OR_JSON_FILE -o DIR [--prototypes P.json]
        writes one dump per blueprint (books are flattened) with recipes/machines attached.
"""
import argparse
import base64
import json
import os
import re
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_PROTOTYPES = os.path.join(HERE, "data", "prototypes-2.0-base.json")
RENAMES_2_0 = {
    "stack-inserter": "bulk-inserter",
    "stack-filter-inserter": "bulk-inserter",
    "filter-inserter": "fast-inserter",
    "logistic-chest-passive-provider": "passive-provider-chest",
    "logistic-chest-active-provider": "active-provider-chest",
    "logistic-chest-storage": "storage-chest",
    "logistic-chest-buffer": "buffer-chest",
    "logistic-chest-requester": "requester-chest",
    "straight-rail": "legacy-straight-rail",  # only for pre-2.0 strings
    "curved-rail": "legacy-curved-rail",
}
LONG_REACH = {"long-handed-inserter": 2}


def decode(s):
    s = s.strip()
    if not s or s[0] != "0":
        raise ValueError("not a version-0 blueprint string")
    return json.loads(zlib.decompress(base64.b64decode(s[1:])))


def encode(obj):
    raw = json.dumps(obj, separators=(",", ":")).encode()
    return "0" + base64.b64encode(zlib.compress(raw, 9)).decode()


def load(path):
    text = open(path).read().strip()
    if text.startswith("{"):
        obj = json.loads(text)
        if "blueprintString" in obj:  # factorioprints record
            return decode(obj["blueprintString"])
        return obj
    return decode(text)


def game_major(version):
    return (version or 0) >> 48


def walk(obj, path=""):
    """Yield (path, blueprint dict) for every blueprint, flattening books."""
    if "blueprint" in obj:
        bp = obj["blueprint"]
        yield (path + "/" + (bp.get("label") or "unnamed")).lstrip("/"), bp
    elif "blueprint_book" in obj:
        book = obj["blueprint_book"]
        for child in book.get("blueprints", []):
            yield from walk(child, path + "/" + (book.get("label") or "book"))


def to_dump(bp, protos):
    pre2 = game_major(bp.get("version")) < 2
    sizes, out = protos["sizes"], []
    unknown = set()
    # Blueprint coordinates are relative; some exports put 1x1 entities on integer coordinates. Shift
    # so odd-sized entities sit on tile centres (x.5), as they do in the world.
    sx = sy = 0.0
    for e in bp.get("entities", []):
        size = sizes.get(RENAMES_2_0.get(e["name"], e["name"]) if pre2 else e["name"])
        if size and size["tw"] == size["th"] and size["tw"] % 2 == 1:
            sx = 0.5 if float(e["position"]["x"]).is_integer() else 0.0
            sy = 0.5 if float(e["position"]["y"]).is_integer() else 0.0
            break
    for e in bp.get("entities", []):
        name = e["name"]
        if pre2:
            name = RENAMES_2_0.get(name, name)
        d = e.get("direction", 0) * (2 if pre2 else 1)
        size = sizes.get(name)
        if not size:
            unknown.add(name)
            size = {"type": "unknown", "tw": 1, "th": 1}
        sideways = d in (4, 12)
        tw, th = (size["th"], size["tw"]) if sideways else (size["tw"], size["th"])
        x, y = e["position"]["x"] + sx, e["position"]["y"] + sy
        rec = {"name": name, "type": size["type"], "x": x, "y": y, "direction": d, "force": "player",
               "w": tw - 0.2, "h": th - 0.2, "tw": tw, "th": th}
        if e.get("recipe"):
            rec["recipe"] = e["recipe"]
        if size["type"] == "underground-belt":
            rec["belt_to_ground_type"] = e.get("type", "input")
        if size["type"] == "inserter":
            # Inserters face the tile they pick up from.
            dx, dy = {0: (0, -1), 4: (1, 0), 8: (0, 1), 12: (-1, 0)}.get(d, (0, 0))
            r = LONG_REACH.get(name, 1)
            rec["pickup"] = {"x": x + dx * r, "y": y + dy * r}
            rec["drop"] = {"x": x - dx * r, "y": y - dy * r}
        out.append(rec)
    used = {r["recipe"] for r in out if r.get("recipe")}
    mach = {r["name"] for r in out if r["type"] in ("assembling-machine", "furnace")}
    xs = [r["x"] for r in out] or [0]
    ys = [r["y"] for r in out] or [0]
    cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
    return {
        "tick": 0, "center": {"x": cx, "y": cy},
        "radius": max(max(xs) - min(xs), max(ys) - min(ys)) / 2 + 3,
        "entities": out,
        "recipes": {k: protos["recipes"][k] for k in used if k in protos["recipes"]},
        "machines": {k: protos["machines"][k] for k in mach if k in protos["machines"]},
        "unknown_entities": sorted(unknown),
        "source_game_version": game_major(bp.get("version")),
    }


def slug(s):
    return re.sub(r"[^a-zA-Z0-9]+", "-", s).strip("-").lower()[:60] or "bp"


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("decode"); p.add_argument("file"); p.add_argument("-o")
    p = sub.add_parser("encode"); p.add_argument("file"); p.add_argument("-o")
    p = sub.add_parser("list"); p.add_argument("file")
    p = sub.add_parser("to-dump"); p.add_argument("file"); p.add_argument("-o", required=True)
    p.add_argument("--prototypes", default=DEFAULT_PROTOTYPES)
    a = ap.parse_args()

    if a.cmd == "decode":
        text = json.dumps(load(a.file), indent=1)
        open(a.o, "w").write(text) if a.o else print(text)
    elif a.cmd == "encode":
        s = encode(json.load(open(a.file)))
        open(a.o, "w").write(s) if a.o else print(s)
    elif a.cmd == "list":
        for path, bp in walk(load(a.file)):
            recipes = sorted({e["recipe"] for e in bp.get("entities", []) if e.get("recipe")})
            print(f"{path}: {len(bp.get('entities', []))} entities, game {game_major(bp.get('version'))}.x, "
                  f"recipes={recipes}")
    elif a.cmd == "to-dump":
        protos = json.load(open(a.prototypes))
        os.makedirs(a.o, exist_ok=True)
        for i, (path, bp) in enumerate(walk(load(a.file))):
            d = to_dump(bp, protos)
            fn = os.path.join(a.o, f"{i:03d}-{slug(path)}.json")
            json.dump(d, open(fn, "w"))
            print(f"{fn}: {len(d['entities'])} entities"
                  + (f", unknown {d['unknown_entities']}" if d["unknown_entities"] else ""))


if __name__ == "__main__":
    main()
