#!/usr/bin/env python3
"""Work-count gate (SPEC §9 performance gates, backlog B10): compares a soak run's deterministic work counters with a
committed baseline and flags rises beyond a tolerance. A soft gate: flags go into the scorecards and the report, the
exit code stays 0 unless --strict.

The mod counts its work (mod/src/work.ts): planner work units, placement candidates scored, router expansions, path
requests, entity scans, jobs processed and reconciler node evaluations, per run and the peak per game-minute. The
counts are written to each seed's telemetry.json ("work") at the run's last telemetry tick; they depend only on the
seed, the config and the code, so they can be compared across machines and with other runs going on.

Usage:
  python3 tools/harness/workcounts.py out/soak/<run>                         # baseline from the run's config
  python3 tools/harness/workcounts.py out/soak/<run> --baseline tools/harness/baselines/m5-work.json
  python3 tools/harness/workcounts.py out/soak/<run> --update               # write the run as the new baseline
  python3 tools/harness/workcounts.py out/soak/<run> --tolerance 0.25

A config names its baseline with `[run] work_baseline = "tools/harness/baselines/<name>.json"`.
"""
import argparse
import datetime
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
KINDS = ["plannerWork", "placementCandidates", "routerExpansions", "pathRequests", "entityScans", "jobsProcessed",
         "reconcilerEvaluations"]
DEFAULT_TOLERANCE = 0.15  # a rise of more than 15% is flagged (run-to-run equal runs give 0%)


def run_work(run_dir):
    """Per seed: tick, totals and peaks per minute from the seeds' telemetry."""
    out = {}
    for d in sorted(Path(run_dir).glob("seed-*"), key=lambda p: int(p.name.split("-")[1])):
        tele = d / "telemetry.json"
        if not tele.exists():
            continue
        t = json.loads(tele.read_text())
        w = t.get("work")
        if not w:
            continue
        out[d.name.split("-")[1]] = {"tick": t.get("tick", 0), "total": w.get("total") or {},
                                     "peakPerMinute": w.get("peakPerMinute") or {}}
    return out


def baseline_path(run_dir, explicit=None):
    if explicit:
        return Path(explicit)
    sc = Path(run_dir) / "scorecard.json"
    if sc.exists():
        p = (json.loads(sc.read_text()).get("config") or {}).get("run", {}).get("work_baseline")
        if p:
            return ROOT / p
    return None


def compare(run, base, tolerance):
    """Rows (seed, kind, what, base, run, ratio, flagged) and the flagged ones. Seeds missing on either side are skipped."""
    rows = []
    for seed in sorted(set(run) & set(base), key=int):
        for what in ("total", "peakPerMinute"):
            for k in KINDS:
                b = float((base[seed].get(what) or {}).get(k, 0) or 0)
                r = float((run[seed].get(what) or {}).get(k, 0) or 0)
                ratio = (r / b) if b > 0 else (None if r == 0 else float("inf"))
                flagged = (b > 0 and r > b * (1 + tolerance)) or (b == 0 and r > 0)
                rows.append((seed, k, what, b, r, ratio, flagged))
    # All seeds together (a steadier signal than one seed).
    seeds = sorted(set(run) & set(base), key=int)
    if len(seeds) > 1:
        for k in KINDS:
            b = sum(float((base[s].get("total") or {}).get(k, 0) or 0) for s in seeds)
            r = sum(float((run[s].get("total") or {}).get(k, 0) or 0) for s in seeds)
            ratio = (r / b) if b > 0 else (None if r == 0 else float("inf"))
            rows.append(("all", k, "total", b, r, ratio, (b > 0 and r > b * (1 + tolerance)) or (b == 0 and r > 0)))
    return rows, [x for x in rows if x[6]]


def fmt(v):
    if v >= 1e6:
        return f"{v / 1e6:.2f}M"
    if v >= 1e4:
        return f"{v / 1e3:.1f}k"
    return f"{v:g}"


def section(run_dir, explicit=None, tolerance=None):
    """Markdown lines for a scorecard, and the number of flags."""
    path = baseline_path(run_dir, explicit)
    run = run_work(run_dir)
    lines = ["## Work counts (SPEC §9 soft gate)", ""]
    if not run:
        return lines + ["No work counters in this run's telemetry (built before B10)."], 0
    if path is None or not path.exists():
        lines.append(f"No baseline ({path or 'none configured: [run] work_baseline'}). Totals per seed:")
        for seed, w in run.items():
            lines.append(f"- seed {seed} ({w['tick'] / 3600:.1f} min): " + ", ".join(f"{k} {fmt(w['total'].get(k, 0))}" for k in KINDS))
        return lines, 0
    base_doc = json.loads(path.read_text())
    tol = tolerance if tolerance is not None else base_doc.get("tolerance", DEFAULT_TOLERANCE)
    rows, flags = compare(run, base_doc.get("seeds", {}), tol)
    lines.append(f"Baseline `{path.relative_to(ROOT) if path.is_relative_to(ROOT) else path}` (commit {base_doc.get('commit', '?')}), "
                 f"tolerance +{tol:.0%}. **{len(flags)} flagged** (a flag is a regression signal, not a failure).")
    lines += ["", "| Seed | Counter | Baseline | This run | Ratio |", "|---|---|---|---|---|"]
    for seed, k, what, b, r, ratio, flagged in rows:
        if what != "total":
            continue
        rs = "—" if ratio is None else ("new" if ratio == float("inf") else f"{ratio:.2f}")
        lines.append(f"| {seed} | {k} | {fmt(b)} | {fmt(r)} | {'**' + rs + '** ⚠' if flagged else rs} |")
    peak_flags = [x for x in flags if x[2] == "peakPerMinute"]
    if peak_flags:
        lines += ["", "Peaks per game-minute flagged:"]
        for seed, k, _, b, r, ratio, _ in peak_flags:
            lines.append(f"- seed {seed} {k}: {fmt(b)} → {fmt(r)}")
    ticks_b = {s: base_doc["seeds"][s].get("tick", 0) for s in base_doc.get("seeds", {})}
    diff_len = [s for s in run if s in ticks_b and ticks_b[s] != run[s]["tick"]]
    if diff_len:
        lines += ["", "Run lengths differ from the baseline (seed: baseline → this run, game-min): " + ", ".join(
            f"{s}: {ticks_b[s] / 3600:.1f} → {run[s]['tick'] / 3600:.1f}" for s in diff_len)
                  + ". Totals scale with run length; compare per minute too."]
    return lines, len(flags)


def git_head():
    try:
        return subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()
    except Exception:
        return "?"


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("run")
    ap.add_argument("--baseline")
    ap.add_argument("--tolerance", type=float)
    ap.add_argument("--update", action="store_true", help="write this run's counts as the baseline")
    ap.add_argument("--strict", action="store_true", help="exit 1 when anything is flagged")
    args = ap.parse_args(argv)
    path = baseline_path(args.run, args.baseline)
    if args.update:
        if path is None:
            sys.exit("no baseline path: pass --baseline or set [run] work_baseline in the config")
        run = run_work(args.run)
        if not run:
            sys.exit("no work counters in this run")
        doc = {"run": Path(args.run).name, "commit": git_head(), "created": datetime.date.today().isoformat(),
               "tolerance": args.tolerance if args.tolerance is not None else DEFAULT_TOLERANCE, "seeds": run}
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(doc, indent=1) + "\n")
        print(f"baseline written: {path}")
        return 0
    lines, flags = section(args.run, args.baseline, args.tolerance)
    print("\n".join(lines))
    return 1 if (flags and args.strict) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
