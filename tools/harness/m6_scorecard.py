#!/usr/bin/env python3
"""M6 scorecard (SPEC §3, §8 M6): reads a soak run's per-seed telemetry (out/soak/<run>/seed-N/telemetry.json, written
by tools/harness/soak.py with tools/harness/m6.toml) and reports, per seed and faction, whether the v1 bar holds:

- science sustained: the labs consumed at least the final stage's target of every pack (30 red + 30 green per minute)
  over `factory-sustain-minutes` (30) game-minutes, within the run's cap (8 game-hours);
- research: every technology of the research goal (D30) researched.

It recomputes the sustained window from the per-minute science samples (packs made and consumed, force item
statistics) rather than trusting the mod's milestone, and reports the best window, phase times, stalls and AI ms/tick.

Usage: python3 tools/harness/m6_scorecard.py out/soak/m6-v1 [--target automation-science-pack=30,logistic-science-pack=30]
       [--window 30] [--hours 8]
Writes <run>/m6-scorecard.md and m6-scorecard.json.
"""
import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import workcounts  # noqa: E402

DURATION = re.compile(r"\[re-telemetry\] tick=(\d+) ticks=(\d+) ai=Duration: ([0-9.]+)ms")
PLAN_FAILED = re.compile(r"goal g\d+ plan failed \(attempt \d+\): (.*)")
EVICTED = re.compile(r"bootstrap site \d+ .* evicted by")
MILESTONES = ["first-electricity-materials", "automated-red-science", "mall-built", "stage-2",
              "automated:logistic-science-pack", "science-sustained", "research-goal-done", "v1-done"]


def minutes(t):
    return None if t is None else round(t / 3600, 1)


def parse_target(s):
    out = {}
    for part in s.split(","):
        k, v = part.split("=")
        out[k.strip()] = float(v)
    return out


def windows(samples, target, window):
    """Best sustained window (min over packs of rate / target) and the first tick each pack-pair window held."""
    best, best_end, first_ok = 0.0, None, None
    rates_at_best = {}
    for i in range(window, len(samples)):
        a, b = samples[i - window], samples[i]
        mins = (b["tick"] - a["tick"]) / 3600
        if mins <= 0:
            continue
        rates = {k: ((b.get("used") or {}).get(k, 0) - (a.get("used") or {}).get(k, 0)) / mins for k in target}
        worst = min(rates[k] / target[k] for k in target)
        if worst > best:
            best, best_end, rates_at_best = worst, b["tick"], rates
        if worst >= 1 and first_ok is None:
            first_ok = b["tick"]
    return best, best_end, first_ok, rates_at_best


def seed_result(seed_dir, target, window, cap_ticks):
    tele = seed_dir / "telemetry.json"
    if not tele.exists():
        return None
    t = json.loads(tele.read_text())
    log_file = seed_dir / "factorio-current.log"
    log = log_file.read_text(errors="replace") if log_file.exists() else ""
    intervals = [(int(n), float(ms)) for _, n, ms in DURATION.findall(log) if int(n) > 0]
    ai = sum(ms for _, ms in intervals) / max(1, sum(n for n, _ in intervals)) if intervals else None
    out = {"seed": seed_dir.name, "tick": t.get("tick", 0), "ai_ms_per_tick": ai, "plan_failures": len(PLAN_FAILED.findall(log)),
           "evictions": len(EVICTED.findall(log)), "factions": {}}
    for name, f in (t.get("factions") or {}).items():
        brain = f.get("brain") or {}
        ms = brain.get("milestones") or {}
        stalls = brain.get("stalls") or []
        if isinstance(stalls, dict):
            stalls = list(stalls.values())
        fac = f.get("factory") or {}
        sc = fac.get("science") or {}
        samples = sc.get("samples") or []
        if isinstance(samples, dict):
            samples = [samples[k] for k in sorted(samples, key=int)]
        best, best_end, first_ok, rates = windows(samples, target, window)
        research = f.get("research") or {}
        sustained_ok = first_ok is not None and first_ok <= cap_ticks
        research_done = ms.get("research-goal-done")
        research_ok = research_done is not None and research_done <= cap_ticks
        unrecovered = [s for s in stalls if s.get("recoveredTick") is None]
        out["factions"][name] = {
            "pass": sustained_ok and research_ok,
            "sustained_minutes": minutes(first_ok),
            "research_minutes": minutes(research_done),
            "best_window": round(best, 3),
            "best_window_end": minutes(best_end),
            "best_rates": {k: round(v, 1) for k, v in rates.items()},
            "researched": research.get("researched"),
            "milestones": {k: minutes(ms.get(k)) for k in MILESTONES},
            "stalls": len(stalls),
            "unrecovered_stalls": len(unrecovered),
            "stall_reasons": [s.get("reason") for s in stalls][:4],
            "waiting": fac.get("waiting"),
            "goals": [g for g in (fac.get("goals") or []) if isinstance(g, dict) and g.get("status") not in ("done",)][-6:],
            "growFails": fac.get("growFails"),
        }
    return out


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("run")
    ap.add_argument("--target", default="automation-science-pack=30,logistic-science-pack=30")
    ap.add_argument("--window", type=int, default=30, help="game minutes the rate must hold")
    ap.add_argument("--hours", type=float, default=8.0, help="game hours within which the bar must be met")
    ap.add_argument("--work-baseline")
    args = ap.parse_args(argv)
    run = Path(args.run)
    target = parse_target(args.target)
    cap = int(args.hours * 216000)
    results = [r for r in (seed_result(d, target, args.window, cap) for d in
                           sorted(run.glob("seed-*"), key=lambda p: int(p.name.split("-")[1]))) if r]
    passed = sum(1 for r in results if r["factions"] and all(f["pass"] for f in r["factions"].values()))
    tgt = " + ".join(f"{v:g} {k}" for k, v in target.items())
    lines = [f"# M6 scorecard: {run.name}", "",
             f"Seeds passed: **{passed}/{len(results)}** (labs consume ≥ {tgt} per minute over {args.window} game-minutes, "
             f"and every research-goal technology, within {args.hours:g} game-hours). Game minutes.", "",
             "| Seed | Pass | Sustained at | All techs at | Best window (× target, ends at) | Techs | Red automated | Stage 2 | Green automated | Stalls | Run | AI ms/tick |",
             "|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for r in results:
        for name, f in r["factions"].items():
            m = f["milestones"]
            ai = "—" if r["ai_ms_per_tick"] is None else f"{r['ai_ms_per_tick']:.3f}"
            lines.append(f"| {r['seed'].split('-')[1]} | {'✅' if f['pass'] else '❌'} | {f['sustained_minutes'] or '—'} | "
                         f"{f['research_minutes'] or '—'} | {f['best_window']} ({f['best_window_end']}) {f['best_rates']} | "
                         f"{f['researched']} | {m['automated-red-science'] or '—'} | {m['stage-2'] or '—'} | "
                         f"{m['automated:logistic-science-pack'] or '—'} | {f['stalls']} | {minutes(r['tick'])} | {ai} |")
    lines += ["", "## Not passed / stalls", ""]
    soak = {}
    if (run / "scorecard.json").exists():
        soak = {f"seed-{x['seed']}": x for x in json.loads((run / "scorecard.json").read_text()).get("results", [])}
    for r in results:
        for name, f in r["factions"].items():
            if f["pass"] and not f["stalls"]:
                continue
            lines.append(f"- **{r['seed']}**: waiting {f['waiting']}; stalls {f['stall_reasons'][:2]}; grow failures {f['growFails']}")
            for g in f["goals"]:
                lines.append(f"  - goal {g.get('id')} {g.get('kind')} {g.get('status')}: {str(g.get('reason'))[:300]}")
            ff = (soak.get(r["seed"]) or {}).get("failed_fast")
            if ff:
                lines.append(f"  - stopped early: {ff}")
            lines.append(f"  - {r['plan_failures']} failed plan attempts, {r['evictions']} bootstrap sites evicted")
    work_lines, _ = workcounts.section(run, args.work_baseline)
    lines += [""] + work_lines
    (run / "m6-scorecard.md").write_text("\n".join(lines) + "\n")
    (run / "m6-scorecard.json").write_text(json.dumps(results, indent=1))
    print("\n".join(lines))


if __name__ == "__main__":
    main(sys.argv[1:])
