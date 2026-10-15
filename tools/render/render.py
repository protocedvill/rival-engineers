"""Schematic top-down renderer for entity dumps written by the mod's `dump_entities` remote call.

Usage:
  python3 tools/render/render.py DUMP.json [DUMP2.json ...] -o out.png   # one frame (last dump)
  python3 tools/render/render.py frames/*.json --gif -o timelapse.gif    # timelapse
  python3 tools/render/render.py frames/*.json --trail -o out.png         # + character trails
  python3 tools/render/render.py DUMP.json --graph GRAPH.json -o out.png   # + Factory Graph overlay (SPEC D29)

The graph overlay (written by the `dump_graph` remote call or the M4b tests) draws module boxes with their ids, ports
(inputs cyan, outputs magenta), and each physical edge along its path, coloured by planned utilization of the belt
(green < 50%, yellow < 90%, orange up to the utilization cap, red over it); undergrounds are dashed, splitters are
white squares, external input stubs are grey. An edge whose overflow decision is not "none" gets a label.

One tile = --scale pixels. Colours are by entity category. Outlines are by force, so factions
are distinguishable.
"""
import argparse
import colorsys
import hashlib
import json
from pathlib import Path
import sys

from PIL import Image, ImageDraw

BACKGROUND = (34, 36, 33)
GRID = (44, 47, 43)

# Entity type -> fill colour. Unknown types fall back to OTHER.
TYPE_COLOURS = {
    "transport-belt": (214, 178, 54),
    "underground-belt": (170, 138, 40),
    "splitter": (230, 200, 90),
    "inserter": (90, 160, 220),
    "mining-drill": (120, 92, 70),
    "furnace": (196, 98, 52),
    "assembling-machine": (110, 130, 150),
    "lab": (160, 200, 240),
    "boiler": (150, 80, 80),
    "generator": (190, 120, 120),
    "offshore-pump": (70, 120, 200),
    "pipe": (80, 110, 160),
    "pipe-to-ground": (60, 90, 140),
    "electric-pole": (200, 200, 200),
    "container": (140, 110, 70),
    "wall": (120, 120, 120),
    "character": (240, 240, 240),
    "resource": (60, 70, 80),
    "tree": (40, 70, 40),
    "simple-entity": (80, 80, 80),
    "entity-ghost": (100, 100, 140),
}
OTHER = (150, 150, 150)
# Some entities are coloured by name rather than type (resources by ore, so patches are recognisable).
NAME_COLOURS = {
    "iron-ore": (72, 96, 122),
    "copper-ore": (150, 82, 46),
    "coal": (16, 16, 16),
    "stone": (128, 112, 82),
    "uranium-ore": (70, 120, 40),
    "crude-oil": (90, 40, 90),
}
WATER = (38, 64, 100)
CLIFF = (96, 80, 64)
# Neutral and resource-like entities are drawn first so buildings sit on top.
LAYER = {"resource": 0, "cliff": 1, "tree": 1, "simple-entity": 1, "character": 9}
# Factorio 2.0 directions are 16-way: 0=N, 4=E, 8=S, 12=W.
DIRECTION_VECTORS = {0: (0, -1), 4: (1, 0), 8: (0, 1), 12: (-1, 0)}
DIRECTIONAL_TYPES = {"transport-belt", "underground-belt", "splitter", "inserter"}


def force_colour(force):
    """Stable, distinct outline colour per force name."""
    if force == "neutral":
        return None
    if force == "player":
        return (255, 255, 255)
    hue = int(hashlib.sha1(force.encode()).hexdigest()[:4], 16) / 0xFFFF
    r, g, b = colorsys.hsv_to_rgb(hue, 0.8, 1.0)
    return (int(r * 255), int(g * 255), int(b * 255))


def bounds(dumps):
    xs0, ys0, xs1, ys1 = [], [], [], []
    for d in dumps:
        cx, cy, r = d["center"]["x"], d["center"]["y"], d["radius"]
        xs0.append(cx - r); ys0.append(cy - r); xs1.append(cx + r); ys1.append(cy + r)
    return min(xs0), min(ys0), max(xs1), max(ys1)


TRAIL = (255, 90, 90)


def character_positions(dump):
    return [(e["x"], e["y"]) for e in dump["entities"] if e["type"] == "character"]


def as_list(v):
    """table_to_json writes empty Lua tables as {}."""
    return v if isinstance(v, list) else []


def utilization_colour(u, cap):
    if u > cap + 1e-9:
        return (230, 50, 50)
    if u >= 0.9:
        return (240, 150, 40)
    if u >= 0.5:
        return (230, 220, 60)
    return (80, 210, 90)


def dashed(draw, a, b, fill, width, dash=6):
    (x0, y0), (x1, y1) = a, b
    length = max(abs(x1 - x0), abs(y1 - y0))
    n = max(1, int(length // dash))
    for i in range(0, n, 2):
        t0, t1 = i / n, min(1, (i + 1) / n)
        draw.line([(x0 + (x1 - x0) * t0, y0 + (y1 - y0) * t0), (x0 + (x1 - x0) * t1, y0 + (y1 - y0) * t1)], fill=fill, width=width)


def draw_graph(draw, graph, box, scale):
    x0, y0 = box[0], box[1]
    px = lambda x, y: ((x + 0.5 - x0) * scale, (y + 0.5 - y0) * scale)
    cap = graph.get("utilization", 0.99)
    phys = graph.get("physical", {})
    for n in as_list(phys.get("nodes")):
        r = n["rect"]
        draw.rectangle([(r["x"] - x0) * scale, (r["y"] - y0) * scale, (r["x"] + r["w"] - x0) * scale - 1, (r["y"] + r["h"] - y0) * scale - 1], outline=(250, 250, 250), width=2)
        draw.text(((r["x"] - x0) * scale + 3, (r["y"] - y0) * scale + 2), n["id"], fill=(255, 255, 255))
        for p in as_list(n.get("ports")):
            if p["kind"] not in ("belt-in", "belt-out"):
                continue
            c = px(p["x"], p["y"])
            colour = (60, 220, 230) if p["kind"] == "belt-in" else (230, 70, 220)
            draw.ellipse([c[0] - scale * 0.3, c[1] - scale * 0.3, c[0] + scale * 0.3, c[1] + scale * 0.3], outline=colour, width=2)
    # Pole lines between modules (planned by the pole network planner).
    for p in as_list(graph.get("poles")):
        c = px(p["x"], p["y"])
        draw.rectangle([c[0] - scale * 0.25, c[1] - scale * 0.25, c[0] + scale * 0.25, c[1] + scale * 0.25], fill=(240, 210, 60))
    lifecycle = {n["id"]: n.get("lifecycle") for n in as_list(graph.get("logical", {}).get("nodes")) if isinstance(n, dict)}
    for n in as_list(phys.get("nodes")):
        if lifecycle.get(n["id"]) in ("planned", "building"):
            r = n["rect"]
            draw.text(((r["x"] - x0) * scale + 3, (r["y"] - y0) * scale + 12), lifecycle[n["id"]], fill=(255, 200, 80))
    for e in as_list(phys.get("edges")):
        cap_info = e.get("capacity", {})
        colour = (150, 150, 150) if e.get("external") else utilization_colour(cap_info.get("utilization", 0), cap)
        width = max(2, scale // 3)
        steps = as_list(e.get("path"))
        pts = []
        for i, st in enumerate(steps):
            if st["kind"] == "splitter":
                a, b = px(st["x"], st["y"]), px(st["x2"], st["y2"])
                c = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
                draw.rectangle([c[0] - scale * 0.4, c[1] - scale * 0.4, c[0] + scale * 0.4, c[1] + scale * 0.4], outline=(255, 255, 255), width=2)
                pts = [b]
                continue
            p = px(st["x"], st["y"])
            if st["kind"] == "ug-out" and pts:
                if len(pts) > 1:
                    draw.line(pts, fill=colour, width=width)
                dashed(draw, pts[-1], p, colour, max(1, width - 1))
                pts = [p]
                continue
            pts.append(p)
        if steps:
            last = steps[-1]
            dx, dy = DIRECTION_VECTORS.get(last["dir"] * 4, (0, 0))
            pts.append(px(last["x"] + dx * 0.6, last["y"] + dy * 0.6))
        if len(pts) > 1:
            draw.line(pts, fill=colour, width=width)
        decision = e.get("decision", {}).get("action", "none")
        if decision != "none" and steps:
            s0 = steps[len(steps) // 2]
            draw.text(px(s0["x"], s0["y"]), f"{e['item']} {cap_info.get('planned', 0):.1f}/{cap_info.get('capacity', 0):.0f} -> {decision}", fill=(255, 120, 120))


def render(dump, box, scale, trail=None, graph=None):
    x0, y0, x1, y1 = box
    img = Image.new("RGB", (int((x1 - x0) * scale), int((y1 - y0) * scale)), BACKGROUND)
    draw = ImageDraw.Draw(img)
    for gx in range(int(x0), int(x1) + 1, 8):
        draw.line([((gx - x0) * scale, 0), ((gx - x0) * scale, img.height)], fill=GRID)
    for gy in range(int(y0), int(y1) + 1, 8):
        draw.line([(0, (gy - y0) * scale), (img.width, (gy - y0) * scale)], fill=GRID)
    for tx, ty in dump.get("water") or []:
        draw.rectangle([(tx - x0) * scale, (ty - y0) * scale, (tx + 1 - x0) * scale - 1, (ty + 1 - y0) * scale - 1], fill=WATER)

    for e in sorted(dump["entities"], key=lambda e: LAYER.get(e["type"], 5)):
        w, h = max(e["w"], 0.4), max(e["h"], 0.4)
        # Buildings use their whole-tile footprint so adjacent machines read as touching.
        if e["type"] not in ("character", "tree", "simple-entity") and "tw" in e:
            w, h = e["tw"], e["th"]
        left = (e["x"] - w / 2 - x0) * scale
        top = (e["y"] - h / 2 - y0) * scale
        # Inset by a pixel when there is room, so neighbours stay distinct at small scales.
        inset = 1 if min(w, h) * scale > 4 else 0
        rect = [left + inset, top + inset, max(left + inset, left + w * scale - inset), max(top + inset, top + h * scale - inset)]
        if e["type"] == "entity-ghost" and e.get("ghost_type"):
            # Planned entity: an outline in the planned type's colour, no fill.
            draw.rectangle(rect, outline=TYPE_COLOURS.get(e["ghost_type"], OTHER), width=1)
            continue
        fill = NAME_COLOURS.get(e["name"]) or (CLIFF if e["type"] == "cliff" else TYPE_COLOURS.get(e["type"], OTHER))
        if e["type"] in ("resource", "tree", "cliff"):
            # Terrain: plain fill, no outline, so patches read as areas.
            draw.rectangle([left, top, left + w * scale - 1, top + h * scale - 1], fill=fill)
            continue
        draw.rectangle(rect, fill=fill, outline=force_colour(e["force"]), width=2 if inset else 1)
        vec = DIRECTION_VECTORS.get(e["direction"])
        if e["type"] in DIRECTIONAL_TYPES and vec:
            cx, cy = (e["x"] - x0) * scale, (e["y"] - y0) * scale
            tip = (cx + vec[0] * scale * 0.4, cy + vec[1] * scale * 0.4)
            draw.line([(cx - vec[0] * scale * 0.3, cy - vec[1] * scale * 0.3), tip], fill=(30, 30, 30), width=2)

    if graph:
        draw_graph(draw, graph, box, scale)

    if trail and len(trail) > 1:
        draw.line([((x - x0) * scale, (y - y0) * scale) for x, y in trail], fill=TRAIL, width=max(2, scale // 2))

    minutes = dump["tick"] / 3600
    draw.text((4, 4), f"{minutes:5.1f} game-min  tick {dump['tick']}", fill=(230, 230, 230))
    return img


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("dumps", nargs="+")
    ap.add_argument("-o", "--out", required=True)
    ap.add_argument("--scale", type=int, default=12, help="pixels per tile")
    ap.add_argument("--gif", action="store_true", help="write all dumps as an animated timelapse")
    ap.add_argument("--frame-ms", type=int, default=400)
    ap.add_argument("--trail", action="store_true", help="draw the path walked by the (single) character across dumps")
    ap.add_argument("--graph", help="Factory Graph JSON to overlay (module boxes, routes by utilization)")
    ap.add_argument("--crop", help="x0,y0,x1,y1 world box to render instead of the dumps' extent")
    ap.add_argument("--graph-dir", help="per-frame Factory Graphs: DIR/<dump name>.graph.json overlays each frame")
    args = ap.parse_args(argv)

    dumps = []
    for path in args.dumps:
        with open(path) as f:
            dumps.append(json.load(f))
    dumps.sort(key=lambda d: d["tick"])
    box = bounds(dumps)
    if args.crop:
        box = tuple(float(v) for v in args.crop.split(","))
    graph = None
    if args.graph:
        with open(args.graph) as f:
            graph = json.load(f)

    trails = []
    trail = []
    for d in dumps:
        trail = trail + character_positions(d)[:1]
        trails.append(trail if args.trail else None)

    def frame_graph(path):
        if not args.graph_dir:
            return graph
        g = Path(args.graph_dir) / (Path(path).stem + ".graph.json")
        if not g.exists():
            return None
        with open(g) as f:
            return json.load(f)

    paths = sorted(args.dumps, key=lambda p: json.load(open(p))["tick"])
    if args.gif:
        frames = [render(d, box, args.scale, t, frame_graph(p)) for d, t, p in zip(dumps, trails, paths)]
        frames[0].save(args.out, save_all=True, append_images=frames[1:], duration=args.frame_ms, loop=0)
    else:
        render(dumps[-1], box, args.scale, trails[-1], frame_graph(paths[-1]) if args.graph_dir else graph).save(args.out)
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main(sys.argv[1:])
