#!/usr/bin/env python3
"""T3 soak harness (SPEC §7): fresh maps, headless at max speed, telemetry, scorecard, render frames.

For every seed in the config it:
  1. creates a fresh map (`--create`, configurable map-gen; biters off by default) with the mod and a generated
     helper mod that applies the run's config overrides through the remote interface at map init;
  2. runs it with `--benchmark` (no rendering, as fast as the CPU allows) for up to `game_hours`, stopping early
     once every faction has finished the bootstrap (the mod writes script-output/rival-engineers/done.json);
  3. collects the mod's telemetry JSON, profiler lines and entity frames, and writes a JSON + markdown scorecard.

Everything runs in an isolated write-data directory, .factorio-test/soak/, separate from factorio-test's
.factorio-test/data and never ~/.factorio.

Usage:
  python3 tools/harness/soak.py                               # tools/harness/soak.toml
  python3 tools/harness/soak.py -c tools/harness/two-factions.toml
  python3 tools/harness/soak.py --seeds 3 --hours 0.5 --gif   # overrides
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FACTORIO = ROOT / ".factorio-test" / "factorio" / "bin" / "x64" / "factorio"
READ_DATA = ROOT / ".factorio-test" / "factorio" / "data"
SOAK_DIR = ROOT / ".factorio-test" / "soak"
TICKS_PER_HOUR = 216000
DONE_MILESTONE = "first-electricity-materials"


def load_config(path, args):
    with open(path, "rb") as f:
        cfg = tomllib.load(f)
    run = cfg.setdefault("run", {})
    if args.seeds:
        run["seeds"] = [int(s) for s in args.seeds.split(",")]
    if args.hours is not None:
        run["game_hours"] = args.hours
    if args.name:
        run["name"] = args.name
    run.setdefault("name", Path(path).stem)
    run.setdefault("seeds", [1, 2, 3, 4, 5])
    run.setdefault("game_hours", 2.0)
    run.setdefault("stop_when_done", True)
    cfg.setdefault("mod", {})
    cfg.setdefault("mapgen", {})
    return cfg


def setup_dir(cfg):
    """Write-data dir with the mod (symlinked build), the helper mod and a mod list."""
    data = SOAK_DIR / "data"
    mods = data / "mods"
    mods.mkdir(parents=True, exist_ok=True)
    (SOAK_DIR / "config.ini").write_text(f"[path]\nread-data={READ_DATA}\nwrite-data={data}\n")
    link = mods / "rival-engineers"
    if link.is_symlink() or link.exists():
        link.unlink()
    link.symlink_to(ROOT / "mod" / "build")
    helper = mods / "rival-engineers-harness"
    shutil.rmtree(helper, ignore_errors=True)
    helper.mkdir()
    (helper / "info.json").write_text(json.dumps({
        "name": "rival-engineers-harness", "version": "0.0.1", "title": "Rival Engineers soak harness",
        "author": "harness", "factorio_version": "2.0", "dependencies": ["rival-engineers"],
    }))
    # Config overrides go through the mod's remote interface at map init, before the first tick spawns factions.
    lines = ["script.on_init(function()"]
    for key, value in sorted(cfg["mod"].items()):
        lua = json.dumps(value) if not isinstance(value, bool) else ("true" if value else "false")
        lines.append(f'  remote.call("rival-engineers", "set_config_override", "{key}", {lua})')
    lines.append("end)")
    (helper / "control.lua").write_text("\n".join(lines) + "\n")
    mod_list = {"mods": [{"name": n, "enabled": e} for n, e in [
        ("base", True), ("elevated-rails", False), ("quality", False), ("space-age", False),
        ("rival-engineers", True), ("rival-engineers-harness", True)]]}
    (mods / "mod-list.json").write_text(json.dumps(mod_list, indent=1))
    return data


def map_gen_settings(cfg):
    mg = cfg["mapgen"]
    settings = {"autoplace_controls": {}}
    if not mg.get("enemy_bases", False):
        settings["autoplace_controls"]["enemy-base"] = {"frequency": 0, "size": 0, "richness": 0}
    for name, ctl in mg.get("autoplace", {}).items():
        settings["autoplace_controls"][name] = ctl
    if "starting_area" in mg:
        settings["starting_area"] = mg["starting_area"]
    return settings


def run_seed(cfg, data, seed, out_dir):
    run = cfg["run"]
    out_dir.mkdir(parents=True, exist_ok=True)
    script_out = data / "script-output" / "rival-engineers"
    shutil.rmtree(script_out, ignore_errors=True)
    saves = SOAK_DIR / "saves"
    saves.mkdir(exist_ok=True)
    save = saves / f"{run['name']}-seed-{seed}.zip"
    mgs = SOAK_DIR / "map-gen-settings.json"
    mgs.write_text(json.dumps(map_gen_settings(cfg)))
    conf = str(SOAK_DIR / "config.ini")
    subprocess.run([str(FACTORIO), "-c", conf, "--create", str(save), "--map-gen-settings", str(mgs),
                    "--map-gen-seed", str(seed)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    ticks = int(run["game_hours"] * TICKS_PER_HOUR)
    log_path = out_dir / "factorio-stdout.log"
    started = time.time()
    stopped_early = False
    with open(log_path, "w") as log:
        proc = subprocess.Popen([str(FACTORIO), "-c", conf, "--benchmark", str(save), "--benchmark-ticks", str(ticks)],
                                stdout=log, stderr=subprocess.STDOUT)
        while proc.poll() is None:
            time.sleep(1)
            if run["stop_when_done"] and (script_out / "done.json").exists():
                time.sleep(0.5)
                proc.kill()  # --benchmark ignores SIGTERM
                stopped_early = True
                try:
                    proc.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    proc.kill()
                break
    wall = time.time() - started
    shutil.copy(data / "factorio-current.log", out_dir / "factorio-current.log")
    if (script_out / "frames").exists():
        shutil.rmtree(out_dir / "frames", ignore_errors=True)
        shutil.copytree(script_out / "frames", out_dir / "frames")
    telemetry = {}
    if (script_out / "telemetry.json").exists():
        telemetry = json.loads((script_out / "telemetry.json").read_text())
        (out_dir / "telemetry.json").write_text(json.dumps(telemetry, indent=1))
    return summarize(seed, telemetry, out_dir / "factorio-current.log", log_path, wall, stopped_early)


DURATION = re.compile(r"\[re-telemetry\] tick=(\d+) ticks=(\d+) ai=Duration: ([0-9.]+)ms")
BENCH = re.compile(r"Performed (\d+) updates in ([0-9.]+) ms")


def summarize(seed, telemetry, log_file, stdout_file, wall, stopped_early):
    text = log_file.read_text(errors="replace")
    intervals = [(int(t), int(n), float(ms)) for t, n, ms in DURATION.findall(text) if int(n) > 0]
    per_tick = [ms / n for _, n, ms in intervals]
    ai_total_ms = sum(ms for _, _, ms in intervals)
    ai_ticks = sum(n for _, n, _ in intervals)
    final_tick = telemetry.get("tick", 0)
    bench = BENCH.search(stdout_file.read_text(errors="replace"))
    errors = [l for l in text.splitlines() if "Error" in l and "rival-engineers" in l][:5]
    factions = {}
    for name, f in telemetry.get("factions", {}).items():
        brain = f.get("brain") or {}
        milestones = {k: v for k, v in sorted((brain.get("milestones") or {}).items(), key=lambda kv: kv[1])}
        stalls = brain.get("stalls") or []
        if isinstance(stalls, dict):
            stalls = list(stalls.values())
        by_kind = {}
        crew_ticks = 0
        idle = 0
        for m in f.get("crew", []):
            st = m.get("stats", {})
            crew_ticks += st.get("ticks", 0)
            idle += st.get("ticks", 0) - st.get("busyTicks", 0)
            for k, v in (st.get("byKind") or {}).items():
                by_kind[k] = by_kind.get(k, 0) + v
        done_tick = milestones.get(DONE_MILESTONE)
        permanent = [s for s in stalls if s.get("recoveredTick") is None and done_tick is None]
        factions[name] = {
            "done": done_tick is not None,
            "done_minutes": round(done_tick / 3600, 1) if done_tick is not None else None,
            "milestones_minutes": {k: round(v / 3600, 1) for k, v in milestones.items()},
            "stalls": stalls,
            "permanent_stalls": len(permanent),
            "replans": brain.get("replans", 0),
            "sites": brain.get("sites", {}),
            "current_goal": brain.get("current"),
            "waiting": brain.get("waiting", []),
            "job_time_share": {k: round(v / crew_ticks, 3) for k, v in sorted(by_kind.items(), key=lambda kv: -kv[1])} if crew_ticks else {},
            "crew_without_claim_share": round(idle / crew_ticks, 3) if crew_ticks else None,
            "counters": f.get("counters"),
        }
    ok = bool(factions) and all(f["done"] and f["permanent_stalls"] == 0 for f in factions.values())
    p99 = sorted(per_tick)[min(len(per_tick) - 1, int(0.99 * len(per_tick)))] if per_tick else None
    return {
        "seed": seed,
        "pass": ok,
        "game_minutes": round(final_tick / 3600, 1),
        "stopped_early": stopped_early,
        "wall_seconds": round(wall, 1),
        "wall_ms_per_tick": round(wall * 1000 / final_tick, 3) if final_tick else None,
        "benchmark": {"ticks": int(bench.group(1)), "ms": float(bench.group(2))} if bench else None,
        "ai_ms_per_tick_avg": round(ai_total_ms / ai_ticks, 4) if ai_ticks else None,
        "ai_ms_per_tick_p99_interval": round(p99, 4) if p99 is not None else None,
        "ai_ms_per_tick_max_interval": round(max(per_tick), 4) if per_tick else None,
        "errors": errors,
        "factions": factions,
    }


def markdown(cfg, results):
    run = cfg["run"]
    passed = sum(1 for r in results if r["pass"])
    lines = [f"# Soak scorecard: {run['name']}", "",
             f"Seeds passed: **{passed}/{len(results)}** (every faction gathered the first-electricity materials, "
             "no permanent stall). Game time in minutes.", "",
             "| Seed | Pass | Faction | Done at (min) | Stalls (recovered) | Replans | AI ms/tick avg / p99 | Wall ms/tick | Current goal at end |",
             "|---|---|---|---|---|---|---|---|---|"]
    for r in results:
        for name, f in r["factions"].items() or [("-", None)]:
            if f is None:
                lines.append(f"| {r['seed']} | ❌ | - | - | - | - | - | - | no telemetry |")
                continue
            rec = sum(1 for s in f["stalls"] if s.get("recoveredTick") is not None)
            lines.append(f"| {r['seed']} | {'✅' if r['pass'] else '❌'} | {name} | {f['done_minutes'] if f['done'] else '—'} | "
                         f"{len(f['stalls'])} ({rec}) | {f['replans']} | {r['ai_ms_per_tick_avg']} / {r['ai_ms_per_tick_p99_interval']} | "
                         f"{r['wall_ms_per_tick']} | {f['current_goal'] or 'done'} |")
    lines += ["", "## Milestones (game minutes)", ""]
    for r in results:
        for name, f in r["factions"].items():
            ms = ", ".join(f"{k} {v}" for k, v in f["milestones_minutes"].items())
            lines.append(f"- seed {r['seed']} faction {name}: {ms}")
    lines += ["", "## Crew time by job kind (share of crew ticks)", ""]
    for r in results:
        for name, f in r["factions"].items():
            share = ", ".join(f"{k} {v:.0%}" for k, v in f["job_time_share"].items())
            lines.append(f"- seed {r['seed']} faction {name}: {share}; no claim {f['crew_without_claim_share']:.0%}" if f["crew_without_claim_share"] is not None else f"- seed {r['seed']} faction {name}: -")
    stalls = [(r["seed"], n, s) for r in results for n, f in r["factions"].items() for s in f["stalls"]]
    lines += ["", "## Stalls", ""]
    if not stalls:
        lines.append("None.")
    for seed, name, s in stalls:
        rec = f"recovered at {s['recoveredTick'] / 3600:.1f} min" if s.get("recoveredTick") is not None else "NOT recovered"
        lines.append(f"- seed {seed} faction {name} at {s['tick'] / 3600:.1f} min ({rec}): {s['reason']}")
    errs = [(r["seed"], e) for r in results for e in r["errors"]]
    if errs:
        lines += ["", "## Errors", ""] + [f"- seed {s}: `{e}`" for s, e in errs]
    return "\n".join(lines) + "\n"


def render_gifs(out_dir, results):
    for r in results:
        frames_root = out_dir / f"seed-{r['seed']}" / "frames"
        if not frames_root.exists():
            continue
        for faction_dir in sorted(p for p in frames_root.iterdir() if p.is_dir()):
            frames = sorted(faction_dir.glob("*.json"))
            if frames:
                gif = out_dir / f"seed-{r['seed']}-faction-{faction_dir.name}.gif"
                subprocess.run([sys.executable, str(ROOT / "tools" / "render" / "render.py"), *map(str, frames), "--gif",
                                "--scale", "3", "-o", str(gif)], check=False)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("-c", "--config", default=str(ROOT / "tools" / "harness" / "soak.toml"))
    parser.add_argument("--seeds", help="comma-separated seeds (overrides the config)")
    parser.add_argument("--hours", type=float, help="game hours per seed (overrides the config)")
    parser.add_argument("--name", help="run name (output directory under out/soak/)")
    parser.add_argument("--no-build", action="store_true")
    parser.add_argument("--gif", action="store_true", help="render a timelapse GIF per seed and faction")
    args = parser.parse_args()
    cfg = load_config(args.config, args)
    if not FACTORIO.exists():
        sys.exit(f"headless Factorio not found at {FACTORIO} (see README → Development)")
    if not args.no_build:
        subprocess.run(["npm", "run", "build"], cwd=ROOT, check=True, stdout=subprocess.DEVNULL)
    data = setup_dir(cfg)
    out_dir = ROOT / "out" / "soak" / cfg["run"]["name"]
    out_dir.mkdir(parents=True, exist_ok=True)
    results = []
    for seed in cfg["run"]["seeds"]:
        print(f"seed {seed}: running up to {cfg['run']['game_hours']} game hours...", flush=True)
        r = run_seed(cfg, data, seed, out_dir / f"seed-{seed}")
        results.append(r)
        for name, f in r["factions"].items():
            print(f"  faction {name}: {'done at ' + str(f['done_minutes']) + ' min' if f['done'] else 'NOT done'}, "
                  f"stalls {len(f['stalls'])}, goal {f['current_goal']}, sites {f['sites']}", flush=True)
        print(f"  {r['game_minutes']} game min in {r['wall_seconds']} s; AI {r['ai_ms_per_tick_avg']} ms/tick", flush=True)
        (out_dir / "scorecard.json").write_text(json.dumps({"config": cfg, "results": results}, indent=1))
        (out_dir / "scorecard.md").write_text(markdown(cfg, results))
    if args.gif:
        render_gifs(out_dir, results)
    passed = sum(1 for r in results if r["pass"])
    print(f"{passed}/{len(results)} seeds passed. Scorecard: {out_dir / 'scorecard.md'}")


if __name__ == "__main__":
    main()
