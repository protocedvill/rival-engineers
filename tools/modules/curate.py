#!/usr/bin/env python3
"""Curated module pipeline (SPEC §5.4): blueprint source -> normalised ModuleDef JSON in data/modules/.

Each curated module has a spec in tools/modules/curated/<id>.json:

  {
    "id": "green-line-hellpet",
    "source": "data/modules/sources/-KuTnAwncOKWGdRP8txp.json",   # factorioprints record (factorioprints.py fetch)
    "blueprint": 0,                      # index in the flattened book
    "description": "...",
    "replace": {"assembling-machine-2": "assembling-machine-1"},  # entity renames (tier downgrade, D20: no steel)
    "recipes": {"fast-inserter": "iron-chest"},                   # recipe swaps (by old recipe name)
    "remove": ["small-lamp"],                                     # entity names to drop
    "remove_at": [[x, y], ...],                                   # drop entities at these positions
  (edit positions are in the coordinates `show` prints without edits: the source translated to (0, 0))
    "add": [{"name": ..., "x": ..., "y": ..., "dir": ...}],       # entities to add (source coordinates)
    "set": [{"at": [x, y], "dir": 4, "name": "...", "recipe": "..."}],  # edit one entity in place
    "remove_rects": [[x0, y0, x1, y1]],  # drop entities whose centre lies in the rectangle
    "crop": [x0, y0, x1, y1],            # keep only this rectangle; its corner becomes (0, 0)
    "rotate": 0..3,                      # quarter turns clockwise applied after the edits
    "ports": [...],                      # Port objects in OUTPUT (module-local) coordinates
    "expand": {...},                     # optional ModuleExpand data (unit entities in unit-local coordinates)
    "notes": ["..."]
  }

Commands (stdlib only; run with python3 -I, the sources are untrusted downloads):

  curate.py show SPEC         print the normalised layout as a character grid (before ports) to design ports
  curate.py build SPEC...     write data/modules/<id>.json, data/modules/render/<id>.json (render.py dump)
                              and refresh data/modules/ATTRIBUTION.md
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)  # our own tools only (not the downloads directory)
import bpstring  # noqa: E402

PROTOS = os.path.join(HERE, "data", "prototypes-2.0-base.json")
OUT_DIR = os.path.join(ROOT, "data", "modules")

GLYPH = {
    "transport-belt": {0: "^", 4: ">", 8: "v", 12: "<"},
    "underground-belt": {0: "U", 4: "U", 8: "U", 12: "U"},
    "splitter": {0: "S", 4: "S", 8: "S", 12: "S"},
    "inserter": {0: "i", 4: "i", 8: "i", 12: "i"},
    "long-handed-inserter": {0: "l", 4: "l", 8: "l", 12: "l"},
    "burner-inserter": {0: "b", 4: "b", 8: "b", 12: "b"},
    "small-electric-pole": {0: "*"},
    "iron-chest": {0: "C"},
    "wooden-chest": {0: "C"},
}


def load_spec(path):
    with open(path) as f:
        return json.load(f)


def source_record(spec):
    with open(os.path.join(ROOT, spec["source"])) as f:
        return json.load(f)


def normalised_entities(spec):
    rec = source_record(spec)
    bp_tree = bpstring.decode(rec["blueprintString"])
    bps = [bp for _, bp in bpstring.walk(bp_tree)]
    bp = bps[spec.get("blueprint", 0)]
    with open(PROTOS) as f:
        protos = json.load(f)
    dump = bpstring.to_dump(bp, protos)
    with open(PROTOS) as f:
        sizes = json.load(f)["sizes"]

    def size(e):
        s = sizes.get(e["name"], {"tw": 1, "th": 1})
        tw, th = s["tw"], s["th"]
        return (th, tw) if e.get("dir", 0) in (4, 12) else (tw, th)

    remove = set(spec.get("remove", []))
    out = []
    for e in dump["entities"]:
        if e["name"] in remove:
            continue
        m = {"name": spec.get("replace", {}).get(e["name"], e["name"]), "x": e["x"], "y": e["y"]}
        if e.get("direction"):
            m["dir"] = e["direction"]
        if e.get("recipe"):
            m["recipe"] = e["recipe"]
        if e.get("belt_to_ground_type"):
            m["ioType"] = e["belt_to_ground_type"]
        out.append(m)
    # Translate so the source's top-left tile is (0, 0). Edits below use these coordinates (`show` prints them).
    minx = min(e["x"] - size(e)[0] / 2 for e in out)
    miny = min(e["y"] - size(e)[1] / 2 for e in out)
    ox, oy = round(minx), round(miny)
    for e in out:
        e["x"] -= ox
        e["y"] -= oy
    remove_at = {(float(x), float(y)) for x, y in spec.get("remove_at", [])}
    rects = spec.get("remove_rects", [])  # [x0, y0, x1, y1]: centres with x0 <= x < x1, y0 <= y < y1

    def in_rects(e):
        return any(r[0] <= e["x"] < r[2] and r[1] <= e["y"] < r[3] for r in rects)

    out = [e for e in out if (e["x"], e["y"]) not in remove_at and not in_rects(e)]
    sets = {(float(s["at"][0]), float(s["at"][1])): s for s in spec.get("set", [])}
    for e in out:
        s = sets.pop((e["x"], e["y"]), None)
        if s:
            for k in ("name", "dir", "recipe", "ioType"):
                if k in s:
                    e[k] = s[k]
            if e.get("dir") == 0:
                del e["dir"]
    if sets:
        raise SystemExit(f"set: no entity at {sorted(sets)}")
    for e in out:
        if e.get("recipe"):
            e["recipe"] = spec.get("recipes", {}).get(e["recipe"], e["recipe"])
    for a in spec.get("add", []):
        out.append(dict(a))
    if "crop" in spec:  # [x0, y0, x1, y1]: keep centres inside, translate x0, y0 to the origin
        x0, y0, x1, y1 = spec["crop"]
        out = [e for e in out if x0 <= e["x"] < x1 and y0 <= e["y"] < y1]
        for e in out:
            e["x"] -= x0
            e["y"] -= y0
        w, h = x1 - x0, y1 - y0
    else:
        w = round(max(e["x"] + size(e)[0] / 2 for e in out))
        h = round(max(e["y"] + size(e)[1] / 2 for e in out))
    for _ in range(spec.get("rotate", 0) % 4):
        for e in out:
            e["x"], e["y"] = h - e["y"], e["x"]
            e["dir"] = (e.get("dir", 0) + 4) % 16
            if e["dir"] == 0:
                del e["dir"]
        w, h = h, w
    out.sort(key=lambda e: (e["y"], e["x"], e["name"]))
    return out, w, h, rec, sizes


def grid(entities, w, h, sizes):
    g = [["." for _ in range(w)] for _ in range(h)]
    for e in entities:
        s = sizes.get(e["name"], {"tw": 1, "th": 1})
        tw, th = (s["th"], s["tw"]) if e.get("dir", 0) in (4, 12) else (s["tw"], s["th"])
        x0, y0 = int(e["x"] - tw / 2 + 0.01), int(e["y"] - th / 2 + 0.01)
        ch = GLYPH.get(e["name"], {}).get(e.get("dir", 0)) or GLYPH.get(e["name"], {}).get(0)
        if ch is None:
            ch = (e.get("recipe") or e["name"])[0].upper()
        for x in range(x0, x0 + tw):
            for y in range(y0, y0 + th):
                if 0 <= y < h and 0 <= x < w:
                    g[y][x] = ch
    return "\n".join(f"{y:3d} " + "".join(r) for y, r in enumerate(g))


def show(path):
    spec = load_spec(path)
    ents, w, h, rec, sizes = normalised_entities(spec)
    print(f"{spec['id']}: {w}x{h}, {len(ents)} entities")
    print("    " + "".join(str(x % 10) for x in range(w)))
    print(grid(ents, w, h, sizes))
    for e in ents:
        if e.get("recipe") or "inserter" in e["name"] or "underground" in e["name"] or "splitter" in e["name"]:
            print("  ", json.dumps(e))


def attribution_line(rec_meta):
    return f"| {rec_meta['title']} | {rec_meta['author']} | {rec_meta['url']} | {rec_meta['licence']} |"


def build(paths):
    os.makedirs(os.path.join(OUT_DIR, "render"), exist_ok=True)
    rows = []
    for path in paths:
        spec = load_spec(path)
        ents, w, h, rec, sizes = normalised_entities(spec)
        meta = spec["attribution"]
        mod = {
            "id": spec["id"],
            "provenance": f"factorioprints: \"{meta['title']}\" by {meta['author']}, {meta['url']}, licence: {meta['licence']}; "
            f"normalised for Rival Engineers (see notes)",
            "description": spec.get("description", ""),
            "footprint": {"w": w, "h": h},
            "entities": ents,
            "ports": spec["ports"],
            "rotatable": True,
            "mirrorable": spec.get("mirrorable", True),
            "notes": spec.get("notes", []),
        }
        for k in ("recipe", "params", "site", "anchor"):
            if k in spec:
                mod[k] = spec[k]
        if "expand" in spec:
            ex = dict(spec["expand"])
            if "unitFrom" in ex:  # the unit is a copy of the module's slice [a, b) along the axis
                a, b = ex.pop("unitFrom")
                key = ex["axis"]
                unit = [dict(e) for e in ents if a <= e[key] < b]
                for e in unit:
                    e[key] -= a
                ex["unit"] = {"footprint": {"w": b - a, "h": h} if key == "x" else {"w": w, "h": b - a}, "entities": unit}
            mod["expand"] = ex
        with open(os.path.join(OUT_DIR, spec["id"] + ".json"), "w") as f:
            json.dump(mod, f, indent=1)
            f.write("\n")
        # A render.py dump for review.
        dump_ents = []
        for e in ents:
            s = sizes.get(e["name"], {"tw": 1, "th": 1, "type": "unknown"})
            tw, th = (s["th"], s["tw"]) if e.get("dir", 0) in (4, 12) else (s["tw"], s["th"])
            dump_ents.append({"name": e["name"], "type": s.get("type", "unknown"), "x": e["x"], "y": e["y"],
                              "direction": e.get("dir", 0), "force": "player", "w": tw - 0.2, "h": th - 0.2,
                              "tw": tw, "th": th, **({"recipe": e["recipe"]} if e.get("recipe") else {})})
        for p in spec["ports"]:
            dump_ents.append({"name": "port", "type": "port", "x": p["pos"]["x"], "y": p["pos"]["y"], "direction": p["dir"],
                              "force": "player", "w": 0.5, "h": 0.5, "tw": 1, "th": 1})
        with open(os.path.join(OUT_DIR, "render", spec["id"] + ".json"), "w") as f:
            json.dump({"tick": 0, "center": {"x": w / 2, "y": h / 2}, "radius": max(w, h) / 2 + 2, "entities": dump_ents}, f)
        rows.append((spec["id"], meta))
        print(f"wrote {spec['id']}: {w}x{h}, {len(ents)} entities, {len(spec['ports'])} ports")
    write_attribution(rows)


def write_attribution(new_rows):
    path = os.path.join(OUT_DIR, "ATTRIBUTION.md")
    existing = {}
    if os.path.exists(path):
        with open(path) as f:
            for line in f:
                if line.startswith("| `"):
                    existing[line.split("`")[1]] = line.rstrip("\n")
    for mid, meta in new_rows:
        existing[mid] = f"| `{mid}` | \"{meta['title']}\" by {meta['author']} | {meta['url']} | {meta['licence']} |"
    with open(path, "w") as f:
        f.write("# Module attribution\n\n")
        f.write("Each curated module in this directory is adapted from a community blueprint, credited below to its original\n")
        f.write("author (SPEC §5.4, D19: attribution is mandatory). The originals are on factorioprints.com, which states no\n")
        f.write("licence: the authors keep their rights, and this project's MIT licence does not cover these modules. The\n")
        f.write("original blueprint strings are cached unchanged in `sources/`. The adaptations bring each blueprint to\n")
        f.write("early-game tech for Rival Engineers (machine and inserter tiers, recipes) and add the ports the planner\n")
        f.write("connects to; each module's `notes` list every change from the original.\n\n")
        f.write("| Module | Adapted from | Original | Licence |\n|---|---|---|---|\n")
        for mid in sorted(existing):
            f.write(existing[mid] + "\n")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("show")
    p.add_argument("spec")
    p = sub.add_parser("build")
    p.add_argument("specs", nargs="+")
    a = ap.parse_args()
    if a.cmd == "show":
        show(a.spec)
    else:
        build(a.specs)


if __name__ == "__main__":
    main()
