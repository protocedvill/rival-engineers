"""Print a short inventory of an entity dump: counts by type, top recipes, bounding box.

Usage: python3 -I tools/modules/dump_stats.py DUMP.json [--top N]
"""
import argparse
import collections
import json


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dump")
    ap.add_argument("--top", type=int, default=25)
    a = ap.parse_args()
    d = json.load(open(a.dump))
    ents = d["entities"]
    types = collections.Counter(e["type"] for e in ents)
    recipes = collections.Counter(e.get("recipe") for e in ents if e["type"] in ("assembling-machine", "furnace"))
    xs = [e["x"] for e in ents]
    ys = [e["y"] for e in ents]
    print(f"{a.dump}: {len(ents)} entities, bbox x[{min(xs):.0f},{max(xs):.0f}] y[{min(ys):.0f},{max(ys):.0f}]")
    print("types:", ", ".join(f"{t}={n}" for t, n in types.most_common(a.top)))
    print("recipes:", ", ".join(f"{r}={n}" for r, n in recipes.most_common(a.top)))


if __name__ == "__main__":
    main()
