#!/usr/bin/env python3
"""T3 soak harness (SPEC §7): fresh maps, headless at max speed, telemetry, scorecard, render frames.

For every seed of every config it:
  1. creates a fresh map (`--create`, configurable map-gen; biters off by default) with the mod and a generated
     helper mod that applies the run's config overrides through the remote interface at map init;
  2. runs it with `--benchmark` (no rendering, as fast as the CPU allows) for up to `game_hours`, stopping early
     once every faction has reached the config's `soakDoneMilestone` (the mod writes
     script-output/rival-engineers/done.json), or, with `run.fail_fast` rules, as soon as the log shows it is stuck
     (stalls, plan failures in a row, leftover ghosts that never get placed);
  3. collects the mod's telemetry JSON, profiler lines and entity frames, and writes a JSON + markdown scorecard.

Seeds (and configs) run concurrently, `--jobs` at a time (default: $SOAK_JOBS, else half the cores). Each run has its
own isolated write-data directory, .factorio-test/soak/<name>/seed-N/, separate from factorio-test's and never
~/.factorio. Concurrent runs slow each other a little (shared caches and memory bandwidth): compare wall and AI ms
per tick only between runs with the same --jobs, and use --jobs 1 for performance numbers.

Usage:
  python3 tools/harness/soak.py                               # tools/harness/soak.toml
  python3 tools/harness/soak.py -c tools/harness/two-factions.toml
  python3 tools/harness/soak.py --seeds 3 --hours 0.5 --gif   # overrides
  python3 tools/harness/soak.py -c tools/harness/soak.toml -c tools/harness/two-factions.toml -j 6
  python3 tools/harness/soak.py -c tools/harness/m5.toml --seeds 3333 --snapshots 5 --name snap   # saves every 5 min
  python3 tools/harness/soak.py -c tools/harness/m5.toml --seeds 3333 --name repro \
      --from-save .factorio-test/soak/snap/seed-3333/data/saves/min-0025.zip           # resume one with the current build

Snapshots (`--snapshots MIN`) run the seed as a headless server sped up by script (saves only work in multiplayer;
`--benchmark` never saves) at about the same speed. A snapshot carries the mod's storage: resuming it with changed code
works as long as the storage layout is compatible, and it only shows the fix's effect from that point on.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import tomllib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import workcounts  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
FACTORIO = ROOT / ".factorio-test" / "factorio" / "bin" / "x64" / "factorio"
READ_DATA = ROOT / ".factorio-test" / "factorio" / "data"
SOAK_DIR = ROOT / ".factorio-test" / "soak"
TICKS_PER_HOUR = 216000
DEFAULT_DONE_MILESTONE = "first-electricity-materials"  # the mod's soak-done-milestone default (M3)
# Fail fast (run.fail_fast in a config): stop a seed as soon as its log shows it is stuck, instead of running to the cap.
FAIL_FAST_KEYS = ("stalls", "consecutive_plan_failures", "ghost_rounds", "exploring_minutes")
STALL_LINE = re.compile(r"STALL at tick (\d+)[^:]*: (.*)")
PLAN_FAILED = re.compile(r"goal (g\d+) plan failed")
PLAN_OK = re.compile(r"goal g\d+ \(\w+\) planned in")
GHOST_ROUND = re.compile(r"goal (g\d+) \d+ ghosts left \(round (\d+)\)")
TICK_LINE = re.compile(r"\[re-telemetry\] tick=(\d+)")
MILESTONE_LINE = re.compile(r"milestone (\S+) at tick (\d+)")
# D62: a search for ore past the home zone (radar outposts) starts and ends.
EXPLORE_START = re.compile(r"EXPLORING \(D62\) since tick (\d+)")
EXPLORE_OVER = re.compile(r"EXPLORE \(D62\) over")
FAILURE_LOG_TAIL_LINES = 200


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def atomic_json(path, value):
    """Write a diagnostic artifact without leaving a plausible-looking partial file."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, indent=2) + "\n")
    os.replace(tmp, path)


def log_tail(path, lines=FAILURE_LOG_TAIL_LINES):
    if not path.exists():
        return []
    return path.read_text(errors="replace").splitlines()[-lines:]


def write_failure_artifact(out_dir, seed, *, reason, command=None, return_code=None,
                           exit_reason=None, failed_fast=None, telemetry=None, error=None):
    """Self-contained first stop for a crashed run; paths point to bulk evidence beside it."""
    artifact = {
        "schema": 1,
        "capturedAt": utc_now(),
        "seed": seed,
        "reason": reason,
        "error": error,
        "command": command,
        "returnCode": return_code,
        "exitReason": exit_reason,
        "failedFast": failed_fast,
        "lastTick": (telemetry or {}).get("tick"),
        "diagnostics": {name: faction.get("diagnostics")
                        for name, faction in (telemetry or {}).get("factions", {}).items()},
        "logs": {
            "factorio-current.log": log_tail(out_dir / "factorio-current.log"),
            "factorio-stdout.log": log_tail(out_dir / "factorio-stdout.log"),
        },
        "evidence": {
            name: sorted(str(path.relative_to(out_dir)) for path in (out_dir / name).rglob("*") if path.is_file())[-1:]
            for name in ("frames", "graphs", "failed-plans", "plans") if (out_dir / name).exists()
        },
    }
    atomic_json(out_dir / "failure.json", artifact)


def git_output(*args):
    return subprocess.run(["git", *args], cwd=ROOT, check=True, text=True, stdout=subprocess.PIPE).stdout.strip()


def build_digest():
    """Content identity of the exact generated mod loaded by Factorio (not an mtime proxy)."""
    build = ROOT / "mod" / "build"
    if not build.exists():
        return None
    digest = hashlib.sha256()
    for path in sorted(p for p in build.rglob("*") if p.is_file()):
        digest.update(str(path.relative_to(build)).encode())
        digest.update(b"\0")
        digest.update(path.read_bytes())
    return digest.hexdigest()


class RunManifest:
    """Atomically updated experiment provenance. Scorecards remain backward-compatible result summaries."""

    def __init__(self, path, cfg, jobs):
        self.path = path
        self.lock = threading.Lock()
        changed = git_output("status", "--short").splitlines()
        self.data = {
            "schema": 1,
            "status": "running",
            "startedAt": utc_now(),
            "completedAt": None,
            "invocation": sys.argv,
            "repo": {
                "commit": git_output("rev-parse", "HEAD"),
                "branch": git_output("rev-parse", "--abbrev-ref", "HEAD"),
                "dirty": bool(changed),
                "changed": changed,
            },
            "build": {"sha256": build_digest()},
            "configSha256": hashlib.sha256(json.dumps(cfg, sort_keys=True).encode()).hexdigest(),
            "jobs": jobs,
            "seeds": {str(seed): {"status": "pending"} for seed in cfg["run"]["seeds"]},
        }
        self.write()

    def write(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(self.data, indent=2) + "\n")
        os.replace(tmp, self.path)

    def seed(self, seed, status, **fields):
        with self.lock:
            item = self.data["seeds"][str(seed)]
            item.update(fields)
            item["status"] = status
            item["updatedAt"] = utc_now()
            self.write()

    def finish(self):
        with self.lock:
            self.data["status"] = "complete"
            self.data["completedAt"] = utc_now()
            self.write()

    def scorecard_meta(self):
        with self.lock:
            finished = sum(1 for seed in self.data["seeds"].values()
                           if seed["status"] not in ("pending", "running"))
            return {
                "partial": finished != len(self.data["seeds"]),
                "finishedSeeds": finished,
                "totalSeeds": len(self.data["seeds"]),
                "manifest": "run.json",
                "commit": self.data["repo"]["commit"],
                "buildSha256": self.data["build"]["sha256"],
            }


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
    run.setdefault("fail_fast", {})
    if args.no_fail_fast:
        run["fail_fast"] = {}
    if args.snapshots is not None:
        run["snapshot_minutes"] = args.snapshots
    run.setdefault("snapshot_minutes", 0)
    if args.helper_lua:
        run["helper_lua"] = str(Path(args.helper_lua).resolve())
    cfg.setdefault("mod", {})
    cfg.setdefault("mapgen", {})
    return cfg


def done_milestone(cfg):
    return cfg["mod"].get("soakDoneMilestone", DEFAULT_DONE_MILESTONE)


def setup_dir(cfg, seed):
    """A run's own dir: write-data (the mod as a symlinked build, the helper mod, a mod list), config.ini, the map."""
    run_dir = SOAK_DIR / cfg["run"]["name"] / f"seed-{seed}"
    data = run_dir / "data"
    mods = data / "mods"
    mods.mkdir(parents=True, exist_ok=True)
    (run_dir / "config.ini").write_text(f"[path]\nread-data={READ_DATA}\nwrite-data={data}\n")
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
    lines = ["local function apply_overrides()"]
    for key, value in sorted(cfg["mod"].items()):
        lua = json.dumps(value) if not isinstance(value, bool) else ("true" if value else "false")
        lines.append(f'  remote.call("rival-engineers", "set_config_override", "{key}", {lua})')
    lines += [
        "end",
        "script.on_init(apply_overrides)",
        "script.on_configuration_changed(apply_overrides)",
        # A resumed save (--from-save) is already past on_init, so the overrides never reached it: the run silently used
        # the save's old settings (debugInfiniteResearch stayed false, which is exactly the flag being validated).
        "script.on_nth_tick(1, function()",
        "  apply_overrides()",
        "  script.on_nth_tick(1, nil)",
        "end)",
    ]
    if cfg["run"].get("helper_lua"):
        # Debug probes (--helper-lua): extra Lua in the helper mod, e.g. an on_nth_tick that logs entity states.
        lines.append(Path(cfg["run"]["helper_lua"]).read_text())
    snap = int(cfg["run"].get("snapshot_minutes") or 0)
    if snap > 0:
        # Snapshot mode runs a headless server (saves only work in multiplayer) as fast as the CPU allows.
        lines += ["script.on_event(defines.events.on_tick, function()",
                  "  if game.speed < 1000 then game.speed = 1000 end",
                  "end)",
                  f"script.on_nth_tick({snap * 3600}, function(e)",
                  '  game.server_save(string.format("min-%04d", math.floor(e.tick / 3600)))',
                  "end)"]
    (helper / "control.lua").write_text("\n".join(lines) + "\n")
    # Space Age smoke runs enable the DLC mods on Nauvis; normal acceptance runs keep them off (SPEC D12/D38).
    dlc = bool(cfg["run"].get("space_age", False))
    mod_list = {"mods": [{"name": n, "enabled": e} for n, e in [
        ("base", True), ("elevated-rails", dlc), ("quality", dlc), ("space-age", dlc),
        ("rival-engineers", True), ("rival-engineers-harness", True)]]}
    (mods / "mod-list.json").write_text(json.dumps(mod_list, indent=1))
    return run_dir


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


class FailFast:
    """Watches a run's log as it grows and says why the run should stop early (None while it looks healthy)."""

    def __init__(self, rules, log_file, resumed=False):
        self.rules = {k: int(v) for k, v in rules.items() if k in FAIL_FAST_KEYS and v}
        # deadlines: milestone -> game hours by which it must have happened (M6: long runs that can't make the bar).
        # A resumed run does not replay the milestones the save already reached, so these absolute-time limits would
        # fire on its first tick (a min-0240 resume reads "no automated-red-science by 1.5 game hours" instantly).
        self.deadlines = {} if resumed else {k: float(v) * TICKS_PER_HOUR for k, v in (rules.get("deadlines") or {}).items()}
        self.milestones = set()
        self.log_file = log_file
        self.pos = 0
        self.partial = ""
        self.stalls = 0
        self.plan_failures = 0
        self.tick = 0
        self.exploring_since = None

    def poll(self):
        if not self.log_file.exists():
            return None
        with open(self.log_file, errors="replace") as f:
            f.seek(self.pos)
            chunk = f.read()
            self.pos = f.tell()
        text = self.partial + chunk
        lines = text.split("\n")
        self.partial = lines.pop()
        reason = None
        for line in lines:
            m = TICK_LINE.search(line)
            if m:
                self.tick = int(m.group(1))
                for name, limit in self.deadlines.items():
                    if name not in self.milestones and self.tick > limit:
                        reason = reason or f"no {name} by {limit / TICKS_PER_HOUR:g} game hours"
            m = MILESTONE_LINE.search(line)
            if m:
                self.milestones.add(m.group(1))
            m = EXPLORE_START.search(line)
            if m:
                self.exploring_since = int(m.group(1))
            if EXPLORE_OVER.search(line):
                self.exploring_since = None
            limit = self.rules.get("exploring_minutes")
            if limit and self.exploring_since is not None and self.tick - self.exploring_since > limit * 3600:
                reason = reason or f"exploring for ore (D62) for over {limit} game-min since tick {self.exploring_since}"
            if STALL_LINE.search(line):
                self.stalls += 1
                if self.rules.get("stalls") and self.stalls >= self.rules["stalls"]:
                    reason = reason or f"{self.stalls} stalls: {STALL_LINE.search(line).group(2)}"
            # A knowledge failure ("no free <ore> patch in the region", "no feasible position") is not the design
            # failing: the mod is exploring for ground (D62), and its own exploring_minutes deadline bounds that.
            # Counting these killed seed 1376111 one attempt before its first exploration started.
            if PLAN_OK.search(line) or self.exploring_since is not None:
                self.plan_failures = 0
            elif PLAN_FAILED.search(line):
                self.plan_failures += 1
                n = self.rules.get("consecutive_plan_failures")
                if n and self.plan_failures >= n:
                    reason = reason or f"{self.plan_failures} plan failures in a row: {line.split('] ', 1)[-1][:300]}"
            m = GHOST_ROUND.search(line)
            if m and self.rules.get("ghost_rounds") and int(m.group(2)) >= self.rules["ghost_rounds"]:
                reason = reason or f"leftover ghosts for {m.group(2)} rounds: {line.split('] ', 1)[-1][:300]}"
        return reason


def run_seed(cfg, seed, out_dir, port=None, from_save=None, status=None):
    run = cfg["run"]
    run_dir = setup_dir(cfg, seed)
    data = run_dir / "data"
    out_dir.mkdir(parents=True, exist_ok=True)
    script_out = data / "script-output" / "rival-engineers"
    shutil.rmtree(script_out, ignore_errors=True)
    shutil.rmtree(data / "saves", ignore_errors=True)
    (data / "saves").mkdir()
    save = run_dir / "map.zip"
    conf = str(run_dir / "config.ini")
    if from_save:
        shutil.copy(from_save, save)
    else:
        mgs = run_dir / "map-gen-settings.json"
        mgs.write_text(json.dumps(map_gen_settings(cfg)))
        subprocess.run([str(FACTORIO), "-c", conf, "--create", str(save), "--map-gen-settings", str(mgs),
                        "--map-gen-seed", str(seed)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    ticks = int(run["game_hours"] * TICKS_PER_HOUR)
    snapshots = int(run.get("snapshot_minutes") or 0) > 0
    if snapshots:
        ss = json.loads((READ_DATA / "server-settings.example.json").read_text())
        ss.update(visibility={"public": False, "lan": False}, require_user_verification=False, auto_pause=False,
                  autosave_interval=100000, autosave_slots=1)
        (run_dir / "server-settings.json").write_text(json.dumps(ss))
        cmd = [str(FACTORIO), "-c", conf, "--start-server", str(save), "--server-settings",
               str(run_dir / "server-settings.json"), "--port", str(port or 34200), "--bind", "127.0.0.1"]
    else:
        cmd = [str(FACTORIO), "-c", conf, "--benchmark", str(save), "--benchmark-ticks", str(ticks)]
    log_path = out_dir / "factorio-stdout.log"
    watch = FailFast(run.get("fail_fast") or {}, data / "factorio-current.log", from_save is not None)
    started = time.time()
    stopped_early = False
    failed_fast = None
    done = False
    capped = False
    exit_reason = "process-exit"
    with open(log_path, "w") as log:
        proc = subprocess.Popen(cmd, stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
        if status:
            status("running", pid=proc.pid, startedAt=utc_now())
        while proc.poll() is None:
            time.sleep(1)
            failed_fast = watch.poll()
            done = run["stop_when_done"] and (script_out / "done.json").exists()
            capped = snapshots and watch.tick >= ticks
            if done or failed_fast or capped:
                exit_reason = "milestone" if done else "fail-fast" if failed_fast else "game-time-cap"
                time.sleep(0.5 if done else 0)
                proc.kill()  # --benchmark ignores SIGTERM
                stopped_early = bool(done or failed_fast)
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
    for sub in ("graphs", "failed-plans", "plans"):
        if (script_out / sub).exists():
            shutil.rmtree(out_dir / sub, ignore_errors=True)
            shutil.copytree(script_out / sub, out_dir / sub)
    telemetry = {}
    if (script_out / "telemetry.json").exists():
        telemetry = json.loads((script_out / "telemetry.json").read_text())
        (out_dir / "telemetry.json").write_text(json.dumps(telemetry, indent=1))
    r = summarize(seed, telemetry, out_dir / "factorio-current.log", log_path, wall, stopped_early, done_milestone(cfg))
    r["failed_fast"] = failed_fast
    r["saves"] = sorted(str(p) for p in (data / "saves").glob("min-*.zip")) if snapshots else []
    fatal = exit_reason == "process-exit" and proc.returncode != 0
    if fatal:
        write_failure_artifact(out_dir, seed, reason="Factorio exited unexpectedly", command=cmd,
                               return_code=proc.returncode, exit_reason=exit_reason,
                               failed_fast=failed_fast, telemetry=telemetry)
    r["_manifest"] = {"pid": proc.pid, "returnCode": proc.returncode, "exitReason": exit_reason,
                      "failureArtifact": f"seed-{seed}/failure.json" if fatal else None}
    return r


DURATION = re.compile(r"\[re-telemetry\] tick=(\d+) ticks=(\d+) ai=Duration: ([0-9.]+)ms")
BENCH = re.compile(r"Performed (\d+) updates in ([0-9.]+) ms")
PROFILE = re.compile(r"\[re-profile\] tick=(\d+) ticks=(\d+) part=(\S+) Duration: ([0-9.]+)ms")


def profile_parts(text):
    """Per on_tick subsystem: average ms a tick over the run, and the worst telemetry interval (ms a tick, at tick)."""
    total, ticks, worst = {}, {}, {}
    for t, n, part, ms in PROFILE.findall(text):
        n, ms = int(n), float(ms)
        if n <= 0:
            continue
        total[part] = total.get(part, 0.0) + ms
        ticks[part] = ticks.get(part, 0) + n
        if ms / n > worst.get(part, (0.0, 0))[0]:
            worst[part] = (ms / n, int(t))
    return {part: {"ms_per_tick_avg": round(total[part] / ticks[part], 4),
                   "worst_interval_ms_per_tick": round(worst[part][0], 4),
                   "worst_interval_tick": worst[part][1]} for part in total if ticks[part] > 0}


def summarize(seed, telemetry, log_file, stdout_file, wall, stopped_early, done_ms=DEFAULT_DONE_MILESTONE):
    text = log_file.read_text(errors="replace")
    stdout_text = stdout_file.read_text(errors="replace")
    intervals = [(int(t), int(n), float(ms)) for t, n, ms in DURATION.findall(text) if int(n) > 0]
    per_tick = [ms / n for _, n, ms in intervals]
    ai_total_ms = sum(ms for _, _, ms in intervals)
    ai_ticks = sum(n for _, n, _ in intervals)
    final_tick = telemetry.get("tick", 0)
    bench = BENCH.search(stdout_text)
    errors = [l for l in (text + "\n" + stdout_text).splitlines()
              if "Error" in l and ("rival-engineers" in l or "Lua" in l)][:5]
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
        takes = {}
        for m in f.get("crew", []):
            st = m.get("stats", {})
            crew_ticks += st.get("ticks", 0)
            idle += st.get("ticks", 0) - st.get("busyTicks", 0)
            for k, v in (st.get("byKind") or {}).items():
                by_kind[k] = by_kind.get(k, 0) + v
            # B36: items taken for jobs by source kind (depot, buffer, furnace, temp-out, chest-out, ...).
            for k, v in (st.get("takes") or {}).items():
                takes[k] = takes.get(k, 0) + v
        done_tick = milestones.get(done_ms)
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
            "takes_by_source": dict(sorted(takes.items(), key=lambda kv: -kv[1])),
            "counters": f.get("counters"),
        }
    ok = bool(factions) and all(f["done"] and f["permanent_stalls"] == 0 for f in factions.values())
    p99 = sorted(per_tick)[min(len(per_tick) - 1, int(0.99 * len(per_tick)))] if per_tick else None
    return {
        "seed": seed,
        "pass": ok,
        "done_milestone": done_ms,
        "game_minutes": round(final_tick / 3600, 1),
        "stopped_early": stopped_early,
        "wall_seconds": round(wall, 1),
        "wall_ms_per_tick": round(wall * 1000 / final_tick, 3) if final_tick else None,
        "benchmark": {"ticks": int(bench.group(1)), "ms": float(bench.group(2))} if bench else None,
        "ai_ms_per_tick_avg": round(ai_total_ms / ai_ticks, 4) if ai_ticks else None,
        "ai_ms_per_tick_p99_interval": round(p99, 4) if p99 is not None else None,
        "ai_ms_per_tick_max_interval": round(max(per_tick), 4) if per_tick else None,
        "profile": profile_parts(text),
        "errors": errors,
        "factions": factions,
        "work": telemetry.get("work"),
    }


def markdown(cfg, results):
    run = cfg["run"]
    passed = sum(1 for r in results if r["pass"])
    lines = [f"# Soak scorecard: {run['name']}", "",
             f"Seeds passed: **{passed}/{len(results)}** (every faction reached `{done_milestone(cfg)}`, "
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
    lines += ["", "## AI time by on_tick subsystem (ms a tick: run average / worst telemetry interval at game minute)", ""]
    parts = []
    for r in results:
        for part in (r.get("profile") or {}):
            if part not in parts:
                parts.append(part)
    if parts:
        lines += ["| Seed | " + " | ".join(parts) + " |", "|---|" + "---|" * len(parts)]
        for r in results:
            prof = r.get("profile") or {}
            cells = []
            for part in parts:
                p = prof.get(part)
                cells.append(f"{p['ms_per_tick_avg']} / {p['worst_interval_ms_per_tick']} @{p['worst_interval_tick'] / 3600:.0f}" if p else "-")
            lines.append(f"| {r['seed']} | " + " | ".join(cells) + " |")
    else:
        lines.append("**WARNING: no `[re-profile]` lines in any seed log: the per-subsystem profile is missing (telemetry off, "
                     "or the mod's profiling is broken).**")
    for r in results:
        if r.get("ai_ms_per_tick_avg") and not r.get("profile"):
            lines.append(f"**WARNING: seed {r['seed']} logged AI time but no `[re-profile]` lines.**")
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
    lines += ["", "## Items taken by source (B36)", ""]
    for r in results:
        for name, f in r["factions"].items():
            t = f.get("takes_by_source") or {}
            lines.append(f"- seed {r['seed']} faction {name}: " + (", ".join(f"{k} {v}" for k, v in t.items()) or "none"))
    stalls = [(r["seed"], n, s) for r in results for n, f in r["factions"].items() for s in f["stalls"]]
    lines += ["", "## Stalls", ""]
    if not stalls:
        lines.append("None.")
    for seed, name, s in stalls:
        rec = f"recovered at {s['recoveredTick'] / 3600:.1f} min" if s.get("recoveredTick") is not None else "NOT recovered"
        lines.append(f"- seed {seed} faction {name} at {s['tick'] / 3600:.1f} min ({rec}): {s['reason']}")
    ff = [(r["seed"], r.get("failed_fast")) for r in results if r.get("failed_fast")]
    if ff:
        lines += ["", "## Stopped early (fail fast)", ""] + [f"- seed {s}: {why}" for s, why in ff]
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


def default_jobs(runs):
    env = os.environ.get("SOAK_JOBS")
    if env:
        return max(1, int(env))
    return max(1, min((os.cpu_count() or 2) // 2, runs))


def failed_result(seed, error):
    return {"seed": seed, "pass": False, "game_minutes": 0, "stopped_early": False, "wall_seconds": None,
            "wall_ms_per_tick": None, "benchmark": None, "ai_ms_per_tick_avg": None, "ai_ms_per_tick_p99_interval": None,
            "ai_ms_per_tick_max_interval": None, "errors": [f"harness: {error!r}"], "factions": {}}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("-c", "--config", action="append",
                        help="config TOML; repeat it to run several configs together (default tools/harness/soak.toml)")
    parser.add_argument("--seeds", help="comma-separated seeds (overrides the config)")
    parser.add_argument("--hours", type=float, help="game hours per seed (overrides the config)")
    parser.add_argument("--name", help="run name (output directory under out/soak/; one config only)")
    parser.add_argument("-j", "--jobs", type=int, help="concurrent Factorio runs (default: $SOAK_JOBS, else half the cores)")
    parser.add_argument("--no-build", action="store_true")
    parser.add_argument("--port-base", type=int, default=34200,
                        help="first server port for --snapshots runs (give a second concurrent soak its own range)")
    parser.add_argument("--gif", action="store_true", help="render a timelapse GIF per seed and faction")
    parser.add_argument("--no-fail-fast", action="store_true", help="ignore the config's run.fail_fast rules")
    parser.add_argument("--snapshots", type=int, metavar="MIN",
                        help="save the game every MIN game-minutes (runs a headless server instead of --benchmark)")
    parser.add_argument("--helper-lua", metavar="LUA",
                        help="append this Lua to the generated helper mod's control.lua (debug probes; see README)")
    parser.add_argument("--from-save", metavar="ZIP",
                        help="continue from a snapshot save (one seed: the seed only names the output) with the current build")
    args = parser.parse_args()
    paths = args.config or [str(ROOT / "tools" / "harness" / "soak.toml")]
    if args.name and len(paths) > 1:
        sys.exit("--name needs a single config")
    cfgs = [load_config(p, args) for p in paths]
    names = [c["run"]["name"] for c in cfgs]
    if len(set(names)) != len(names):
        sys.exit(f"configs share a run name: {names}")
    if args.from_save and len(cfgs) * len(cfgs[0]["run"]["seeds"]) != 1:
        sys.exit("--from-save needs a single config and a single seed (--seeds N)")
    if not FACTORIO.exists():
        sys.exit(f"headless Factorio not found at {FACTORIO} (see README → Development)")
    if not args.no_build:
        subprocess.run(["npm", "run", "build"], cwd=ROOT, check=True, stdout=subprocess.DEVNULL)
    tasks = [(cfg, seed) for cfg in cfgs for seed in cfg["run"]["seeds"]]
    jobs = args.jobs or default_jobs(len(tasks))
    out_dirs = {}
    for cfg in cfgs:
        cfg["run"]["jobs"] = jobs  # recorded in scorecard.json: wall times depend on it
        out_dirs[cfg["run"]["name"]] = ROOT / "out" / "soak" / cfg["run"]["name"]
        out_dirs[cfg["run"]["name"]].mkdir(parents=True, exist_ok=True)
    manifests = {cfg["run"]["name"]: RunManifest(out_dirs[cfg["run"]["name"]] / "run.json", cfg, jobs)
                 for cfg in cfgs}
    results = {name: {} for name in names}
    started = time.time()
    print(f"{len(tasks)} run(s), {jobs} at a time", flush=True)

    ports = {(c["run"]["name"], s): args.port_base + i for i, (c, s) in enumerate(tasks)}

    def task(cfg, seed):
        name = cfg["run"]["name"]
        manifest = manifests[name]
        print(f"{name} seed {seed}: running up to {cfg['run']['game_hours']} game hours...", flush=True)
        try:
            r = run_seed(cfg, seed, out_dirs[name] / f"seed-{seed}", ports[(name, seed)],
                         args.from_save and str(Path(args.from_save).resolve()),
                         lambda state, **fields: manifest.seed(seed, state, **fields))
            meta = r.pop("_manifest")
            state = "passed" if r["pass"] else "failed-fast" if r.get("failed_fast") else "failed"
            manifest.seed(seed, state, **meta, gameMinutes=r["game_minutes"], wallSeconds=r["wall_seconds"])
            return r
        except BaseException as e:
            seed_dir = out_dirs[name] / f"seed-{seed}"
            seed_dir.mkdir(parents=True, exist_ok=True)
            write_failure_artifact(seed_dir, seed, reason="Harness exception", error=repr(e))
            manifest.seed(seed, "crashed", error=repr(e))
            raise

    with ThreadPoolExecutor(max_workers=jobs) as pool:
        futures = {pool.submit(task, cfg, seed): (cfg, seed) for cfg, seed in tasks}
        for fut in as_completed(futures):
            cfg, seed = futures[fut]
            name = cfg["run"]["name"]
            try:
                r = fut.result()
            except Exception as e:  # a broken run fails its seed, not the others
                r = failed_result(seed, e)
            results[name][seed] = r
            lines = [f"{name} seed {seed}: {r['game_minutes']} game min in {r['wall_seconds']} s; "
                     f"AI {r['ai_ms_per_tick_avg']} ms/tick"]
            for fname, f in r["factions"].items():
                lines.append(f"  faction {fname}: {'done at ' + str(f['done_minutes']) + ' min' if f['done'] else 'NOT done'}, "
                             f"stalls {len(f['stalls'])}, goal {f['current_goal']}, sites {f['sites']}")
            if r.get("profile"):
                top = sorted(r["profile"].items(), key=lambda kv: -kv[1]["ms_per_tick_avg"])[:3]
                lines.append("  profile (ms/tick): " + ", ".join(f"{k} {v['ms_per_tick_avg']}" for k, v in top))
            elif r.get("ai_ms_per_tick_avg"):
                lines.append("  WARNING: no [re-profile] lines in the log (per-subsystem profile missing)")
            if r.get("failed_fast"):
                lines.append(f"  STOPPED (fail fast): {r['failed_fast']}")
            if r.get("saves"):
                lines.append(f"  snapshots: {r['saves'][0]} ... ({len(r['saves'])})")
            lines += [f"  error: {e}" for e in r["errors"]]
            print("\n".join(lines), flush=True)
            # The scorecard so far, in config seed order.
            ordered = [results[name][s] for s in cfg["run"]["seeds"] if s in results[name]]
            meta = manifests[name].scorecard_meta()
            (out_dirs[name] / "scorecard.json").write_text(json.dumps({"meta": meta, "config": cfg, "results": ordered}, indent=1))
            warning = f"> **PARTIAL:** {meta['finishedSeeds']}/{meta['totalSeeds']} seeds finished. See `run.json`.\n\n" if meta["partial"] else ""
            (out_dirs[name] / "scorecard.md").write_text(warning + markdown(cfg, ordered))
    for cfg in cfgs:
        name = cfg["run"]["name"]
        manifests[name].finish()
        ordered = [results[name][s] for s in cfg["run"]["seeds"]]
        if args.gif:
            render_gifs(out_dirs[name], ordered)
        work_lines, flags = workcounts.section(out_dirs[name])
        with open(out_dirs[name] / "scorecard.md", "a") as f:
            f.write("\n" + "\n".join(work_lines) + "\n")
        print(f"{name}: work counts: {flags} flagged against the baseline (see scorecard.md)")
        passed = sum(1 for r in ordered if r["pass"])
        print(f"{name}: {passed}/{len(ordered)} seeds reached {done_milestone(cfg)}. Scorecard: {out_dirs[name] / 'scorecard.md'}")
    print(f"soak wall time {time.time() - started:.1f} s ({len(tasks)} run(s), {jobs} at a time)")


if __name__ == "__main__":
    main()
