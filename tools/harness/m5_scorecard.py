#!/usr/bin/env python3
"""M5 scorecard (SPEC §8 M5): reads a soak run's per-seed telemetry (out/soak/<run>/seed-N/telemetry.json, written by
tools/harness/soak.py with tools/harness/m5.toml) and reports, per seed and faction, whether automated red science
reached the labs with research progressing, the game time, its breakdown by phase, stalls, and AI ms/tick.

The generic soak scorecard judges the M3 milestone; this one judges M5's.

Usage: python3 tools/harness/m5_scorecard.py out/soak/m5-red-science [--milestone automated-red-science]
Writes <run>/m5-scorecard.md and m5-scorecard.json next to the soak scorecard.
"""
import argparse
import json
import re
import sys
from pathlib import Path

PHASES = [
    ("bootstrap", None, "first-electricity-materials"),
    ("power + labs", "first-electricity-materials", "labs-built"),
    ("research to unblock", "labs-built", "production-planned"),
    ("production build", "production-planned", "production-built"),
    ("automation verified", "production-built", "automated-red-science"),
]
PLAN_FAILED = re.compile(r"goal g\d+ plan failed \(attempt \d+\): (.*)")
GHOSTS_LEFT = re.compile(r"(goal g\d+ \d+ ghosts left) \(round (\d+)\): (.*)")
DURATION = re.compile(r"\[re-telemetry\] tick=(\d+) ticks=(\d+) ai=Duration: ([0-9.]+)ms")


RECONCILER = re.compile(r"reconciler ((?:grow|repair|upkeep) .*)")


def minutes(t):
    return None if t is None else round(t / 3600, 1)


def seed_result(seed_dir, milestone):
    tele = seed_dir / "telemetry.json"
    if not tele.exists():
        return None
    t = json.loads(tele.read_text())
    log = (seed_dir / "factorio-current.log").read_text(errors="replace") if (seed_dir / "factorio-current.log").exists() else ""
    intervals = [(int(n), float(ms)) for _, n, ms in DURATION.findall(log) if int(n) > 0]
    ai = sum(ms for _, ms in intervals) / max(1, sum(n for n, _ in intervals)) if intervals else None
    per = sorted(ms / n for n, ms in intervals)
    p99 = per[min(len(per) - 1, int(0.99 * len(per)))] if per else None
    failures = PLAN_FAILED.findall(log)
    distinct = []
    for msg in reversed(failures):
        for part in msg.split("; "):
            if part not in distinct:
                distinct.append(part)
    ghosts = GHOSTS_LEFT.findall(log)
    diag = {"plan_failures": len(failures), "plan_failure_kinds": distinct[:4],
            "ghosts_left": f"{ghosts[-1][0]} (round {ghosts[-1][1]}): {ghosts[-1][2][:400]}" if ghosts else None}
    out = {"seed": seed_dir.name, "diag": diag, "tick": t.get("tick", 0), "ai_ms_per_tick": ai, "ai_ms_p99_interval": p99, "factions": {}}
    for name, f in (t.get("factions") or {}).items():
        brain = f.get("brain") or {}
        ms = brain.get("milestones") or {}
        stalls = brain.get("stalls") or []
        if isinstance(stalls, dict):
            stalls = list(stalls.values())
        done = ms.get(milestone)
        phases = {}
        for label, a, b in PHASES:
            ta = 0 if a is None else ms.get(a)
            tb = ms.get(b)
            phases[label] = minutes(tb - ta) if ta is not None and tb is not None else None
        fac = f.get("factory") or {}
        unrecovered = [s for s in stalls if s.get("recoveredTick") is None]
        out["factions"][name] = {
            "pass": done is not None,
            "minutes": minutes(done),
            "phases": phases,
            "milestones": {k: minutes(v) for k, v in sorted(ms.items(), key=lambda kv: kv[1])},
            "stalls": len(stalls),
            "unrecovered_stalls": len(unrecovered) if done is None else 0,
            "stall_reasons": [s.get("reason") for s in stalls][:5],
            "goals": fac.get("goals"),
            "waiting": fac.get("waiting"),
            "research": f.get("research"),
            "design": fac.get("design"),
            "verify": fac.get("verify"),
            "reconciler": fac.get("reconciler"),
        }
    return out


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("run")
    ap.add_argument("--milestone", default="automated-red-science")
    args = ap.parse_args(argv)
    run = Path(args.run)
    results = []
    for d in sorted(run.glob("seed-*"), key=lambda p: int(p.name.split("-")[1])):
        r = seed_result(d, args.milestone)
        if r:
            results.append(r)
    passed = sum(1 for r in results if r["factions"] and all(f["pass"] for f in r["factions"].values()))
    lines = [f"# M5 scorecard: {run.name}", "", f"Seeds passed: **{passed}/{len(results)}** (milestone `{args.milestone}`: "
             "automated red science feeding labs with research progressing). Game minutes.", "",
             "| Seed | Pass | Total | " + " | ".join(p[0] for p in PHASES) + " | Stalls | AI ms/tick avg / p99 |",
             "|---|---|---|" + "---|" * len(PHASES) + "---|---|"]
    for r in results:
        for name, f in r["factions"].items():
            ph = " | ".join("—" if f["phases"][p[0]] is None else str(f["phases"][p[0]]) for p in PHASES)
            ai = "—" if r["ai_ms_per_tick"] is None else f"{r['ai_ms_per_tick']:.3f} / {r['ai_ms_p99_interval']:.3f}"
            lines.append(f"| {r['seed'].split('-')[1]} | {'✅' if f['pass'] else '❌'} | {f['minutes'] if f['pass'] else '— (' + str(minutes(r['tick'])) + ' run)'} | {ph} | {f['stalls']} | {ai} |")
    lines += ["", "## Milestones", ""]
    for r in results:
        for name, f in r["factions"].items():
            lines.append(f"- {r['seed']}: " + ", ".join(f"{k} {v}" for k, v in f["milestones"].items()))
    lines += ["", "## Reconciler (M5b): node statuses at the end, remedies, root causes", ""]
    for r in results:
        log = (Path(args.run) / r["seed"] / "factorio-current.log")
        acted = RECONCILER.findall(log.read_text(errors="replace")) if log.exists() else []
        for name, f in r["factions"].items():
            rc = f.get("reconciler") or {}
            if not rc:
                lines.append(f"- {r['seed']} {name}: not running")
                continue
            lines.append(f"- {r['seed']} {name}: {rc.get('evaluations')} evaluations, {rc.get('probes')} edge probes; statuses "
                         f"{rc.get('statuses')}; status changes {rc.get('changes')}; remedies {rc.get('remedies') or {}}")
            for c in (rc.get("causes") or [])[:6]:
                lines.append(f"  - cause: {c[:300]}")
            for a in acted[:8]:
                lines.append(f"  - remedy: {a[:300]}")
    lines += ["", "## Not passed / stalls", ""]
    soak = {}
    if (run / "scorecard.json").exists():
        soak = {f"seed-{x['seed']}": x for x in json.loads((run / "scorecard.json").read_text()).get("results", [])}
    for r in results:
        for name, f in r["factions"].items():
            if not f["pass"] or f["stalls"]:
                active = [f"{g.get('id')} {g.get('kind')} {g.get('status')}" for g in (f["goals"] or [])
                          if isinstance(g, dict) and g.get("status") not in ("done", "failed")][-3:]
                lines.append(f"- **{r['seed']}**: goals {active}; waiting {f['waiting']}; stalls {f['stall_reasons'][:2]}")
                ff = (soak.get(r["seed"]) or {}).get("failed_fast")
                if ff:
                    lines.append(f"  - stopped early: {ff}")
                d = r["diag"]
                if d["plan_failures"]:
                    lines.append(f"  - {d['plan_failures']} failed plan attempts; latest kinds: " + " | ".join(d["plan_failure_kinds"]))
                if d["ghosts_left"]:
                    lines.append(f"  - {d['ghosts_left']}")
    (run / "m5-scorecard.md").write_text("\n".join(lines) + "\n")
    (run / "m5-scorecard.json").write_text(json.dumps(results, indent=1))
    print("\n".join(lines))


if __name__ == "__main__":
    main(sys.argv[1:])
