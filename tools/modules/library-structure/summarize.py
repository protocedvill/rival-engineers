"""Summarise the decoder's JSON: record counts by kind and the book tree (labels, entity counts).

Usage: python3 -I summarize.py LIBRARY.json [--depth 1]
"""
import argparse
import collections
import json


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("library")
    ap.add_argument("--depth", type=int, default=1, help="book nesting depth to print")
    a = ap.parse_args()
    lib = json.load(open(a.library))["library"]
    kinds = collections.Counter()
    lines = []

    def walk(table, depth):
        for slot in table["slots"]:
            r = slot["record"]
            kinds[r["kind"]] += 1
            label = r["metadata"].get("label", "")
            show = depth <= a.depth
            if r["kind"] == "blueprint-book":
                if show:
                    lines.append(f"{'  ' * depth}[book] {label} ({len(r['book']['contents']['slots'])} slots)")
                walk(r["book"]["contents"], depth + 1)
            elif show:
                ents = (r.get("blueprint") or {}).get("entity_count", "")
                lines.append(f"{'  ' * depth}[{r['kind']}] {label} {f'entities={ents}' if ents else ''}")

    walk(lib["root"], 0)
    v = lib["version"]
    print(f"storage version {v['major']}.{v['minor']}.{v['patch']}.{v['build']}: {dict(kinds)}")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
