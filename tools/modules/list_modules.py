"""One line per candidate module: id, footprint, ports, rates, review flags.

Usage: python3 -I tools/modules/list_modules.py MODULES.json [--early] [--clean]
"""
import argparse
import json


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("modules")
    ap.add_argument("--early", action="store_true", help="only early-game, v1-tech modules")
    ap.add_argument("--clean", action="store_true", help="only modules with no review flags")
    a = ap.parse_args()
    for m in json.load(open(a.modules)):
        flags = m["review"]["flags"]
        if a.clean and flags:
            continue
        if a.early and ("not-early-game" in flags or any(f.startswith("beyond") for f in flags)):
            continue
        ports = ",".join(f"{p['kind'].replace('belt-', '')}:{p['item']}" for p in m["ports"])
        outs = ",".join(f"{r['item']}={r['per_s']:.2f}/s" for r in m["rates"]["outputs"])
        print(f"{m['id']:<55} {m['footprint']['w']:>3}x{m['footprint']['h']:<3} ents={len(m['entities']):<4} "
              f"out[{outs}] ports[{ports}] flags={flags} missing_in={m['review']['missing_input_ports']}")


if __name__ == "__main__":
    main()
