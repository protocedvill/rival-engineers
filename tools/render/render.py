"""Schematic top-down renderer for entity dumps written by the mod's `dump_entities` remote call.

Usage:
  python3 tools/render/render.py DUMP.json [DUMP2.json ...] -o out.png   # one frame (last dump)
  python3 tools/render/render.py frames/*.json --gif -o timelapse.gif    # timelapse
  python3 tools/render/render.py frames/*.json --trail -o out.png         # + character trails

One tile = --scale pixels. Colours are by entity category. Outlines are by force, so factions
are distinguishable.
"""
import argparse
import colorsys
import hashlib
import json
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
# Neutral and resource-like entities are drawn first so buildings sit on top.
LAYER = {"resource": 0, "tree": 1, "simple-entity": 1, "character": 9}
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


def render(dump, box, scale, trail=None):
    x0, y0, x1, y1 = box
    img = Image.new("RGB", (int((x1 - x0) * scale), int((y1 - y0) * scale)), BACKGROUND)
    draw = ImageDraw.Draw(img)
    for gx in range(int(x0), int(x1) + 1, 8):
        draw.line([((gx - x0) * scale, 0), ((gx - x0) * scale, img.height)], fill=GRID)
    for gy in range(int(y0), int(y1) + 1, 8):
        draw.line([(0, (gy - y0) * scale), (img.width, (gy - y0) * scale)], fill=GRID)

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
        draw.rectangle(rect, fill=TYPE_COLOURS.get(e["type"], OTHER), outline=force_colour(e["force"]), width=2 if inset else 1)
        vec = DIRECTION_VECTORS.get(e["direction"])
        if e["type"] in DIRECTIONAL_TYPES and vec:
            cx, cy = (e["x"] - x0) * scale, (e["y"] - y0) * scale
            tip = (cx + vec[0] * scale * 0.4, cy + vec[1] * scale * 0.4)
            draw.line([(cx - vec[0] * scale * 0.3, cy - vec[1] * scale * 0.3), tip], fill=(30, 30, 30), width=2)

    if trail and len(trail) > 1:
        draw.line([((x - x0) * scale, (y - y0) * scale) for x, y in trail], fill=TRAIL, width=max(2, scale // 2))

    draw.text((4, 4), f"tick {dump['tick']}  entities {len(dump['entities'])}", fill=(230, 230, 230))
    return img


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("dumps", nargs="+")
    ap.add_argument("-o", "--out", required=True)
    ap.add_argument("--scale", type=int, default=12, help="pixels per tile")
    ap.add_argument("--gif", action="store_true", help="write all dumps as an animated timelapse")
    ap.add_argument("--frame-ms", type=int, default=400)
    ap.add_argument("--trail", action="store_true", help="draw the path walked by the (single) character across dumps")
    args = ap.parse_args(argv)

    dumps = []
    for path in args.dumps:
        with open(path) as f:
            dumps.append(json.load(f))
    dumps.sort(key=lambda d: d["tick"])
    box = bounds(dumps)

    trails = []
    trail = []
    for d in dumps:
        trail = trail + character_positions(d)[:1]
        trails.append(trail if args.trail else None)

    if args.gif:
        frames = [render(d, box, args.scale, t) for d, t in zip(dumps, trails)]
        frames[0].save(args.out, save_all=True, append_images=frames[1:], duration=args.frame_ms, loop=0)
    else:
        render(dumps[-1], box, args.scale, trails[-1]).save(args.out)
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main(sys.argv[1:])
