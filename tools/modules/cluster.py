"""Cluster a save's entity dump into candidate modules (prototype, SPEC §5.4 steps 1-3).

Input: a dump written by dump-mod/re-save-dump (entities + recipes + machines).
Output: a JSON list of ModuleDef-like candidates, plus optional render dumps for tools/render/render.py.

Usage:
  python3 -I tools/modules/cluster.py DUMP.json -o modules.json [--provenance NAME]
      [--render-dir DIR] [--max-machines 24] [--early-only]

Algorithm (prototype-grade, see docs/reports/proto-module-sourcing.md):
  1. Index every tile -> entity. Link each inserter to the entities under its pickup and drop tiles.
  2. Union-find over crafting machines that have a recipe:
       - direct insertion: an inserter moves items from machine A into machine B;
       - same recipe and an inserter of each touches the same belt tile (or adjacent belt tiles);
       - same recipe, aligned neighbours (gap <= 1 tile) along the row axis. The row axis is
         perpendicular to the side the machine's inserters sit on, so back-to-back rows don't merge.
     Clusters larger than --max-machines are cut into chunks along their long axis.
  3. Module = machines + their inserters + the belts those inserters touch, then everything else that
     lies fully inside that bounding box (belts, undergrounds, splitters, poles, pipes, chests), minus
     belt chains that no module inserter touches (buses passing through).
  4. Ports: a module belt whose successor tile holds a belt outside the module is a belt-out; an outside
     belt whose successor is a module belt is a belt-in. Items come from what is on the belt chain,
     intersected with the recipe's ingredients/products. Pipes crossing the edge become pipe ports.
  5. Normalise: translate to the origin and rotate so the first belt-out faces north.
"""
import argparse
import collections
import json
import math
import os

BELTS = {"transport-belt", "underground-belt", "splitter"}
MACHINES = {"assembling-machine", "furnace"}
SKIP_TYPES = {"entity-ghost", "tile-ghost", "construction-robot", "logistic-robot", "character-corpse",
              "car", "spider-vehicle", "locomotive", "cargo-wagon", "fluid-wagon", "item-request-proxy",
              "deconstructible-tile-proxy", "corpse", "item-entity"}
# Entities that make up a module besides machines/inserters/belts. Anything else inside the box is foreign.
FILLER_TYPES = BELTS | {"electric-pole", "pipe", "pipe-to-ground", "container", "pump", "storage-tank",
                        "lamp", "constant-combinator", "inserter"}
# SPEC §5.4 step 3: things beyond v1 tech.
BEYOND_V1_TYPES = {"beacon", "roboport", "logistic-container", "construction-robot", "logistic-robot"}
BEYOND_V1_CATEGORIES = {"chemistry", "oil-processing", "centrifuging", "rocket-building"}
EARLY_RECIPES = {
    "iron-plate", "copper-plate", "stone-brick", "steel-plate", "iron-gear-wheel", "copper-cable",
    "electronic-circuit", "automation-science-pack", "logistic-science-pack", "military-science-pack",
    "transport-belt", "inserter", "pipe", "iron-stick", "firearm-magazine", "piercing-rounds-magazine",
    "grenade", "stone-wall", "underground-belt", "splitter", "fast-transport-belt", "fast-inserter",
    "long-handed-inserter", "assembling-machine-1", "assembling-machine-2", "electric-mining-drill",
    "stone-furnace", "small-electric-pole", "medium-electric-pole", "rail", "engine-unit",
}
DIRS = {0: (0, -1), 4: (1, 0), 8: (0, 1), 12: (-1, 0)}


def tiles_of(e):
    """Whole tiles covered by an entity, using its rotated tile footprint."""
    tw, th = e.get("tw") or 1, e.get("th") or 1
    x0 = math.floor(e["x"] - tw / 2 + 0.01)
    y0 = math.floor(e["y"] - th / 2 + 0.01)
    return [(x, y) for x in range(x0, x0 + tw) for y in range(y0, y0 + th)]


def tile(p):
    return (math.floor(p["x"]), math.floor(p["y"]))


class UnionFind:
    def __init__(self):
        self.p = {}

    def find(self, a):
        self.p.setdefault(a, a)
        while self.p[a] != a:
            self.p[a] = self.p[self.p[a]]
            a = self.p[a]
        return a

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.p[max(ra, rb)] = min(ra, rb)


class Base:
    def __init__(self, dump):
        self.recipes = dump.get("recipes", {})
        self.machine_speed = {k: v["crafting_speed"] for k, v in dump.get("machines", {}).items()}
        self.ents = [e for e in dump["entities"] if e["type"] not in SKIP_TYPES]
        self.at = {}
        for i, e in enumerate(self.ents):
            e["_tiles"] = tiles_of(e)
            for t in e["_tiles"]:
                self.at[t] = i
        self.under_pair = self._pair_undergrounds()

    def _pair_undergrounds(self):
        pair = {}
        for i, e in enumerate(self.ents):
            if e["type"] != "underground-belt" or e.get("belt_to_ground_type") != "input":
                continue
            dx, dy = DIRS.get(e["direction"], (0, 0))
            tx, ty = tile(e)
            for k in range(1, 12):
                j = self.at.get((tx + dx * k, ty + dy * k))
                if j is None:
                    continue
                o = self.ents[j]
                if o["type"] == "underground-belt" and o["name"] == e["name"] and o["direction"] == e["direction"]:
                    if o.get("belt_to_ground_type") == "output":
                        pair[i] = j
                    break
        return pair

    def successors(self, i):
        """Tiles a belt-like entity pushes items into (one per lane block)."""
        e = self.ents[i]
        dx, dy = DIRS.get(e["direction"], (0, 0))
        if e["type"] == "underground-belt" and e.get("belt_to_ground_type") == "input":
            j = self.under_pair.get(i)
            return [tile(self.ents[j])] if j is not None else []
        return [(tx + dx, ty + dy) for tx, ty in e["_tiles"]]

    def belt_at(self, t, exclude_opposite_of=None):
        j = self.at.get(t)
        if j is None or self.ents[j]["type"] not in BELTS:
            return None
        if exclude_opposite_of is not None and (self.ents[j]["direction"] - exclude_opposite_of) % 16 == 8:
            return None
        return j


def box_of(ents):
    xs0 = min(min(t[0] for t in e["_tiles"]) for e in ents)
    ys0 = min(min(t[1] for t in e["_tiles"]) for e in ents)
    xs1 = max(max(t[0] for t in e["_tiles"]) for e in ents)
    ys1 = max(max(t[1] for t in e["_tiles"]) for e in ents)
    return xs0, ys0, xs1, ys1


def cluster_machines(base, max_machines):
    machines = [i for i, e in enumerate(base.ents) if e["type"] in MACHINES and e.get("recipe")]
    mset = set(machines)
    uf = UnionFind()
    touched = collections.defaultdict(set)   # machine -> belt tiles its inserters touch
    inserters = collections.defaultdict(list)  # machine -> inserter idx
    side = collections.defaultdict(collections.Counter)  # machine -> 'ns'/'ew' inserter count
    for i, e in enumerate(base.ents):
        if e["type"] != "inserter" or "pickup" not in e:
            continue
        a, b = base.at.get(tile(e["pickup"])), base.at.get(tile(e["drop"]))
        for m, other in ((a, b), (b, a)):
            if m in mset:
                inserters[m].append(i)
                side[m]["ns" if e["direction"] in (0, 8) else "ew"] += 1
                if other is not None and base.ents[other]["type"] in BELTS:
                    t = tile(e["pickup"] if other == a else e["drop"])
                    touched[m].add(t)
        if a in mset and b in mset:
            uf.union(a, b)  # direct insertion

    # Shared belts, same recipe.
    belt_owner = collections.defaultdict(list)
    for m in machines:
        for t in touched[m]:
            belt_owner[t].append(m)
    for t, ms in belt_owner.items():
        near = list(ms)
        for dx, dy in ((1, 0), (0, 1), (-1, 0), (0, -1)):
            near += belt_owner.get((t[0] + dx, t[1] + dy), [])
        for m in near:
            for n in ms:
                if base.ents[m]["recipe"] == base.ents[n]["recipe"]:
                    uf.union(m, n)

    # Aligned row neighbours along the row axis.
    by_key = collections.defaultdict(list)
    for m in machines:
        e = base.ents[m]
        by_key[(e["recipe"], e["tw"], e["th"])].append(m)
    for (_, tw, th), ms in by_key.items():
        pos = {(base.ents[m]["x"], base.ents[m]["y"]): m for m in ms}
        for m in ms:
            e = base.ents[m]
            ins_side = side[m].most_common(1)[0][0] if side[m] else None
            # Inserters on N/S sides -> row runs E-W; on E/W sides -> row runs N-S.
            steps = []
            if ins_side != "ew":
                steps += [(tw, 0), (tw + 1, 0)]
            if ins_side != "ns":
                steps += [(0, th), (0, th + 1)]
            for sx, sy in steps:
                n = pos.get((e["x"] + sx, e["y"] + sy))
                if n is not None:
                    uf.union(m, n)

    groups = collections.defaultdict(list)
    for m in machines:
        groups[uf.find(m)].append(m)
    out = []
    for ms in groups.values():
        if len(ms) <= max_machines:
            out.append((ms, False))
            continue
        xs = [base.ents[m]["x"] for m in ms]
        ys = [base.ents[m]["y"] for m in ms]
        key = (lambda m: base.ents[m]["x"]) if max(xs) - min(xs) >= max(ys) - min(ys) else (lambda m: base.ents[m]["y"])
        ms = sorted(ms, key=key)
        for k in range(0, len(ms), max_machines):
            out.append((ms[k:k + max_machines], True))
    return out, inserters, touched


def build_module(base, ms, inserters, touched):
    mset = set(ms)
    core = set(ms)
    for m in ms:
        for i in inserters[m]:
            e = base.ents[i]
            a, b = base.at.get(tile(e["pickup"])), base.at.get(tile(e["drop"]))
            # Keep inserters whose other end is a belt, a chest, nothing, or a machine in this module.
            ok = True
            for o in (a, b):
                if o is not None and base.ents[o]["type"] in MACHINES and o not in mset:
                    ok = False
            if ok:
                core.add(i)
        for t in touched[m]:
            j = base.at.get(t)
            if j is not None:
                core.add(j)
    x0, y0, x1, y1 = box_of([base.ents[i] for i in core])
    members = set(core)
    foreign_tiles = 0
    for x in range(x0, x1 + 1):
        for y in range(y0, y1 + 1):
            j = base.at.get((x, y))
            if j is None or j in members:
                continue
            e = base.ents[j]
            inside = all(x0 <= tx <= x1 and y0 <= ty <= y1 for tx, ty in e["_tiles"])
            if inside and e["type"] in FILLER_TYPES:
                if e["type"] == "inserter" and "pickup" in e:
                    ends = [base.at.get(tile(e["pickup"])), base.at.get(tile(e["drop"]))]
                    if any(o is not None and base.ents[o]["type"] in MACHINES and o not in mset for o in ends):
                        foreign_tiles += 1
                        continue
                members.add(j)
            elif e["type"] in MACHINES or e["type"] not in FILLER_TYPES:
                foreign_tiles += 1

    # Drop belt chains that no module inserter touches (bus belts crossing the box).
    used_tiles = set()
    for m in ms:
        used_tiles |= touched[m]
    belts = [j for j in members if base.ents[j]["type"] in BELTS]
    bset = set(belts)
    adj = collections.defaultdict(set)
    for j in belts:
        for t in base.successors(j):
            k = base.belt_at(t)
            if k in bset:
                adj[j].add(k)
                adj[k].add(j)
    seen = set()
    for j in belts:
        if j in seen:
            continue
        comp, stack = [], [j]
        seen.add(j)
        while stack:
            c = stack.pop()
            comp.append(c)
            for n in adj[c]:
                if n not in seen:
                    seen.add(n)
                    stack.append(n)
        if not any(t in used_tiles for c in comp for t in base.ents[c]["_tiles"]):
            members -= set(comp)
    return members, foreign_tiles, (x0, y0, x1, y1)


def chain_items(base, start, members, forward):
    """Items seen on belts of the module chain starting at `start`."""
    items = collections.Counter()
    chain_tiles = set()
    preds = None
    if not forward:
        preds = collections.defaultdict(list)
        for j in members:
            if base.ents[j]["type"] in BELTS:
                for t in base.successors(j):
                    k = base.belt_at(t)
                    if k is not None:
                        preds[k].append(j)
    seen, stack = {start}, [start]
    while stack:
        c = stack.pop()
        items.update(base.ents[c].get("items", {}))
        chain_tiles.update(base.ents[c]["_tiles"])
        nxt = []
        if forward:
            nxt = [base.belt_at(t) for t in base.successors(c)]
        else:
            nxt = preds.get(c, [])
        for n in nxt:
            if n is not None and n in members and n not in seen:
                seen.add(n)
                stack.append(n)
    return items, chain_tiles


def find_ports(base, members, ingredients, products):
    """Belt and pipe ports. Each belt port lists every recipe item seen on its chain; when the chain is
    empty, the role of the inserters touching it (pick = input, drop = output) decides."""
    ports = []
    picks, drops = set(), set()
    for j in members:
        e = base.ents[j]
        if e["type"] == "inserter" and "pickup" in e:
            picks.add(tile(e["pickup"]))
            drops.add(tile(e["drop"]))

    def port(kind, t, d, start, forward):
        items, ctiles = chain_items(base, start, members, forward)
        want = ingredients if kind == "belt-in" else products
        found = [n for n, _ in items.most_common() if n in ingredients | products]
        source = "belt-contents"
        if not found:
            # Nothing on the belt (idle save, or a blueprint): use what the touching inserters do.
            source = "inserter-role"
            if ctiles & drops:
                found = sorted(products)
            elif ctiles & picks:
                found = sorted(ingredients)  # input belt, or leftover input continuing out
        primary = next((n for n in found if n in want), found[0] if found else None)
        return {"kind": kind, "tile": t, "dir": d, "item": primary, "items": found, "item_source": source}

    mtiles = {t for j in members for t in base.ents[j]["_tiles"]}
    for j in members:
        e = base.ents[j]
        if e["type"] in BELTS:
            for t in base.successors(j):
                k = base.belt_at(t, exclude_opposite_of=e["direction"])
                if k is not None and k not in members:
                    src = tile(e) if e["type"] != "splitter" else (t[0] - DIRS[e["direction"]][0], t[1] - DIRS[e["direction"]][1])
                    ports.append(port("belt-out", src, e["direction"], j, False))
        elif e["type"] in ("pipe", "pipe-to-ground"):
            for t in e["_tiles"]:
                for dx, dy in ((1, 0), (0, 1), (-1, 0), (0, -1)):
                    k = base.at.get((t[0] + dx, t[1] + dy))
                    if k is not None and k not in members and base.ents[k]["type"] in ("pipe", "pipe-to-ground", "pump", "storage-tank", "offshore-pump"):
                        ports.append({"kind": "pipe", "tile": t, "dir": None, "item": None})
    # Inbound: outside belts pushing into module belts.
    seen = set()
    for t in mtiles:
        for dx, dy in ((1, 0), (0, 1), (-1, 0), (0, -1), (0, 0)):
            k = base.at.get((t[0] + dx, t[1] + dy))
            if k is None or k in members or k in seen or base.ents[k]["type"] not in BELTS:
                continue
            seen.add(k)
            for s in base.successors(k):
                j = base.belt_at(s)
                if j in members:
                    ports.append(port("belt-in", s, base.ents[k]["direction"], j, True))
    # Dangling belt ends (the normal case for blueprints): a belt with nothing after it is an output,
    # a belt nothing feeds is an input.
    fed = set()
    for j in members:
        if base.ents[j]["type"] in BELTS:
            for t in base.successors(j):
                k = base.belt_at(t)
                if k is not None:
                    fed.add(k)
    for p in ports:
        if p["kind"] == "belt-in":
            fed.add(base.at.get(p["tile"]))
    for j in members:
        e = base.ents[j]
        if e["type"] not in BELTS or e["type"] == "splitter":
            continue
        if e["type"] == "underground-belt" and e.get("belt_to_ground_type") == "output" and j in fed:
            pass
        elif j not in fed and not (e["type"] == "underground-belt" and e.get("belt_to_ground_type") == "output"):
            # Only an input if the module picks from this chain; else it is just where an output belt starts.
            _, ctiles = chain_items(base, j, members, True)
            if ctiles & picks:
                ports.append(port("belt-in", tile(e), e["direction"], j, True))
        if not any(base.at.get(t) is not None for t in base.successors(j)) and \
                not (e["type"] == "underground-belt" and e.get("belt_to_ground_type") == "input"):
            # A dead end is an output only if the module drops onto this chain; an input belt that
            # simply ends after the last machine is not a port.
            _, ctiles = chain_items(base, j, members, False)
            if ctiles & drops:
                ports.append(port("belt-out", tile(e), e["direction"], j, False))
    return ports


def rotate(entities, ports, k):
    """Rotate k quarter turns clockwise around the origin (y down) and re-anchor at (0, 0)."""
    def rot(x, y):
        for _ in range(k):
            x, y = -y, x
        return x, y
    for e in entities:
        e["x"], e["y"] = rot(e["x"], e["y"])
        e["direction"] = (e["direction"] + 4 * k) % 16
        if k % 2:
            e["tw"], e["th"] = e["th"], e["tw"]
            e["w"], e["h"] = e["h"], e["w"]
    ports = [p for p in ports if p["x"] is not None]
    for p in ports:
        p["x"], p["y"] = rot(p["x"], p["y"])
        if p["dir"] is not None:
            p["dir"] = (p["dir"] + 4 * k) % 16
    minx = min(e["x"] - e["tw"] / 2 for e in entities)
    miny = min(e["y"] - e["th"] / 2 for e in entities)
    for o in entities + ports:
        o["x"] -= minx
        o["y"] -= miny


def make_module(base, ms, members, foreign, box, provenance, idx):
    recipes = collections.Counter(base.ents[m]["recipe"] for m in ms)
    main_recipe = recipes.most_common(1)[0][0]
    rates_in, rates_out = collections.Counter(), collections.Counter()
    for m in ms:
        e = base.ents[m]
        r = base.recipes.get(e["recipe"])
        if not r:
            continue
        crafts = base.machine_speed.get(e["name"], 1) / r["energy"]
        for ing in r["ingredients"]:
            rates_in[ing["name"]] += crafts * ing["amount"]
        for p in r["products"]:
            rates_out[p["name"]] += crafts * p.get("amount", 1) * p.get("probability", 1)
    # Internal intermediates (made and consumed inside) are not external rates.
    for name in set(rates_in) & set(rates_out):
        d = rates_out[name] - rates_in[name]
        rates_out[name], rates_in[name] = max(d, 0), max(-d, 0)
    # Name the module after the recipe making its largest external output (e.g. circuits, not cables).
    final = [r for r in recipes if any(rates_out.get(p["name"], 0) > 1e-9
                                       for p in base.recipes.get(r, {}).get("products", []))]
    if final:
        consumed = {i["name"] for r in recipes for i in base.recipes.get(r, {}).get("ingredients", [])}
        main_recipe = max(final, key=lambda r: (
            not any(p["name"] in consumed for p in base.recipes[r]["products"]),
            max(rates_out.get(p["name"], 0) for p in base.recipes[r]["products"])))
    ingredients = {k for k, v in rates_in.items() if v > 1e-9}
    products = {k for k, v in rates_out.items() if v > 1e-9}
    ports = find_ports(base, members, ingredients, products)

    ents = []
    for j in sorted(members, key=lambda j: (base.ents[j]["y"], base.ents[j]["x"])):
        e = base.ents[j]
        ent = {k: e[k] for k in ("name", "type", "x", "y", "direction", "force", "w", "h", "tw", "th")}
        if e.get("recipe"):
            ent["recipe"] = e["recipe"]
        if e.get("belt_to_ground_type"):
            ent["belt_to_ground_type"] = e["belt_to_ground_type"]
        ents.append(ent)
    port_objs = [{"kind": p["kind"], "x": p["tile"][0] + 0.5, "y": p["tile"][1] + 0.5, "dir": p["dir"],
                  "item": p["item"], "items": p.get("items", []), "item_source": p.get("item_source")}
                 for p in ports]
    if not any(base.ents[j]["type"] == "electric-pole" for j in members) and \
            any(base.ents[j]["type"] in ("inserter", "assembling-machine") for j in members):
        port_objs.append({"kind": "power", "x": None, "y": None, "dir": None, "item": None, "items": []})
    outs = [p for p in port_objs if p["kind"] == "belt-out"]
    k = ((16 - outs[0]["dir"]) // 4) % 4 if outs else 0
    rotate(ents, port_objs, k)
    w = max(e["x"] + e["tw"] / 2 for e in ents)
    h = max(e["y"] + e["th"] / 2 for e in ents)

    types = {base.ents[j]["type"] for j in members}
    cats = {base.recipes.get(r, {}).get("category") for r in recipes}
    flags = []
    if types & BEYOND_V1_TYPES:
        flags.append("beyond-v1-entities")
    if cats & BEYOND_V1_CATEGORIES:
        flags.append("beyond-v1-recipe-category")
    if not all(r in EARLY_RECIPES for r in recipes):
        flags.append("not-early-game")
    area = (box[2] - box[0] + 1) * (box[3] - box[1] + 1)
    if foreign / area > 0.05:
        flags.append("foreign-entities-in-box")
    in_items = {i for p in port_objs if p["kind"] == "belt-in" for i in p["items"]}
    out_items = {i for p in port_objs if p["kind"] == "belt-out" for i in p["items"]}
    missing_in = sorted(ingredients - in_items)
    missing_out = sorted(products - out_items)
    if not outs:
        flags.append("no-belt-out")
    if missing_in:
        flags.append("unfed-ingredients")
    if any(p["kind"] == "power" for p in port_objs):
        flags.append("no-poles-inside")
    if in_items & out_items & ingredients:
        flags.append("pass-through-belt")
    if any(p["item"] is None for p in port_objs if p["kind"].startswith("belt")):
        flags.append("port-item-unknown")
    machine_counts = collections.Counter(base.ents[m]["name"] for m in ms)
    return {
        "id": f"{provenance}-{main_recipe}-{len(ms)}m-{idx}",
        "source": "curated",
        "provenance": f"save:{provenance} box=({box[0]},{box[1]})-({box[2]},{box[3]}) rotated={k * 90}deg",
        "footprint": {"w": int(round(w)), "h": int(round(h))},
        "recipe": main_recipe,
        "recipes": dict(recipes),
        "machines": [{"name": n, "count": c} for n, c in machine_counts.items()],
        "rates": {"inputs": [{"item": i, "per_s": round(rates_in[i], 4)} for i in sorted(ingredients)],
                  "outputs": [{"item": i, "per_s": round(rates_out[i], 4)} for i in sorted(products)]},
        "ports": port_objs,
        "requiresTech": [],  # TODO(M4): derive from prototypes (unlock tech of every recipe/entity).
        "rotatable": True,
        "entities": ents,
        "review": {"flags": flags, "foreign_tiles": foreign, "box_area": area,
                   "missing_input_ports": missing_in, "missing_output_ports": missing_out},
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dump")
    ap.add_argument("-o", "--out", required=True)
    ap.add_argument("--provenance", default=None)
    ap.add_argument("--max-machines", type=int, default=24)
    ap.add_argument("--min-machines", type=int, default=2)
    ap.add_argument("--whole", action="store_true", help="one module from all machines (for blueprints)")
    ap.add_argument("--render-dir", default=None, help="write one render.py dump per module with no review flags")
    ap.add_argument("--render-all", action="store_true", help="with --render-dir: render every module")
    a = ap.parse_args()
    prov = a.provenance or os.path.splitext(os.path.basename(a.dump))[0]
    base = Base(json.load(open(a.dump)))
    groups, inserters, touched = cluster_machines(base, 10 ** 9 if a.whole else a.max_machines)
    if a.whole:
        groups = [([m for ms, _ in groups for m in ms], False)]
    mods = []
    for idx, (ms, split) in enumerate(sorted(groups, key=lambda g: -len(g[0]))):
        if len(ms) < a.min_machines:
            continue
        members, foreign, box = build_module(base, ms, inserters, touched)
        mod = make_module(base, ms, members, foreign, box, prov, idx)
        if split:
            mod["review"]["flags"].append("chunk-of-larger-cluster")
        mods.append(mod)
    with open(a.out, "w") as f:
        json.dump(mods, f, indent=1)
    clean = [m for m in mods if not m["review"]["flags"]]
    early = [m for m in mods if "not-early-game" not in m["review"]["flags"]
             and not any(f.startswith("beyond") for f in m["review"]["flags"])]
    flags = collections.Counter(f for m in mods for f in m["review"]["flags"])
    print(f"{prov}: {len(groups)} machine clusters, {len(mods)} candidates (>= {a.min_machines} machines), "
          f"{len(early)} early-game, {len(clean)} with no review flags")
    print("flags:", dict(flags))
    if a.render_dir:
        os.makedirs(a.render_dir, exist_ok=True)
        for m in (mods if a.render_all else clean):
            r = max(m["footprint"]["w"], m["footprint"]["h"]) / 2 + 1
            d = {"tick": 0, "center": {"x": m["footprint"]["w"] / 2, "y": m["footprint"]["h"] / 2}, "radius": r,
                 "entities": m["entities"] + [
                     {"name": p["kind"], "type": p["kind"], "x": p["x"], "y": p["y"], "direction": p["dir"] or 0,
                      "force": "neutral", "w": 0.5, "h": 0.5} for p in m["ports"] if p["x"] is not None]}
            with open(os.path.join(a.render_dir, m["id"] + ".json"), "w") as f:
                json.dump(d, f)


if __name__ == "__main__":
    main()
