#!/usr/bin/env python3
"""T4 determinism check (SPEC §7): one seed run three ways must reach the same state at the same tick.

  A  fresh, as a snapshot server (saves at --save-minute)
  B  fresh, under --benchmark (no saves)
  C  resumed from A's save at --save-minute, under --benchmark

At each --dump-minutes tick the mod writes its canonical state (`state_dump`: sorted storage plus the factions'
entities and researched technologies) to script-output; the three files must be byte-identical. On a mismatch the first
differing spot is printed with context.

  python3 tools/harness/determinism.py --seed 11 --dump-minutes 30 --save-minute 20 --no-build
"""

import argparse
import hashlib
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOAK_DIR = ROOT / ".factorio-test" / "soak"
TICKS_PER_MINUTE = 3600


def helper_lua(ticks):
    # on_nth_tick(60): the snapshot helper owns on_tick and on_nth_tick(save interval), and on_nth_tick(1) is cleared
    # after the config overrides; 60 collides with neither (dump ticks are whole minutes).
    listed = ", ".join(str(t) for t in ticks)
    return f"""
local DUMP_TICKS = {{{listed}}}
script.on_nth_tick(60, function(e)
  for _, t in pairs(DUMP_TICKS) do
    if e.tick == t then remote.call("rival-engineers", "state_dump", "determinism/tick-" .. t .. ".txt") end
  end
end)
"""


def soak(args, name, helper, hours, extra):
    cmd = [sys.executable, str(ROOT / "tools" / "harness" / "soak.py"), "-c", args.config, "--seeds", str(args.seed),
           "--name", name, "-j", "1", "--hours", f"{hours:.4f}", "--no-build", "--no-fail-fast",
           "--helper-lua", helper, *extra]
    print(f"[determinism] {name}: {' '.join(extra) or 'benchmark'}", flush=True)
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    return SOAK_DIR / name / f"seed-{args.seed}" / "data"


def first_difference(a, b, context=240):
    n = min(len(a), len(b))
    i = next((k for k in range(n) if a[k] != b[k]), n)
    lo = max(0, i - context)
    return i, a[lo:i + context], b[lo:i + context]


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--config", default=str(ROOT / "tools" / "harness" / "m6.toml"))
    p.add_argument("--seed", type=int, default=11)
    p.add_argument("--dump-minutes", default="30", help="comma-separated game minutes to compare at")
    p.add_argument("--save-minute", type=int, default=20, help="A's snapshot interval; C resumes from the first one")
    p.add_argument("--name", default="det")
    p.add_argument("--port-base", type=int, default=38200)
    p.add_argument("--no-build", action="store_true")
    args = p.parse_args()
    if not args.no_build:
        subprocess.run(["npm", "run", "build"], cwd=ROOT, check=True)
    minutes = sorted(int(m) for m in args.dump_minutes.split(","))
    ticks = [m * TICKS_PER_MINUTE for m in minutes]
    if minutes[0] <= args.save_minute:
        sys.exit("--dump-minutes must all come after --save-minute (C starts there)")
    # Run a minute past the last dump so it is written before the run stops.
    end_hours = (minutes[-1] + 1) / 60
    with tempfile.TemporaryDirectory() as tmp:
        sys.exit(0 if compare(args, minutes, ticks, end_hours, Path(tmp)) else 1)


def compare(args, minutes, ticks, end_hours, tmp):
    helper = tmp / "dump.lua"
    helper.write_text(helper_lua(ticks))
    helper = str(helper)
    a = soak(args, f"{args.name}-A", helper, end_hours, ["--snapshots", str(args.save_minute), "--port-base", str(args.port_base)])
    b = soak(args, f"{args.name}-B", helper, end_hours, [])
    save = a / "saves" / f"min-{args.save_minute:04d}.zip"
    if not save.exists():
        sys.exit(f"A wrote no save at minute {args.save_minute} ({save})")
    # --from-save copies the zip into C's own dir; keep a copy in case A's dir is reused.
    kept = tmp / save.name
    kept.write_bytes(save.read_bytes())
    c = soak(args, f"{args.name}-C", helper, (minutes[-1] + 1 - args.save_minute) / 60, ["--from-save", str(kept)])
    ok = True
    for t in ticks:
        files = {k: d / "script-output" / "determinism" / f"tick-{t}.txt" for k, d in (("A", a), ("B", b), ("C", c))}
        missing = [k for k, f in files.items() if not f.exists()]
        if missing:
            print(f"tick {t}: no dump from {', '.join(missing)}")
            ok = False
            continue
        data = {k: f.read_bytes() for k, f in files.items()}
        sums = {k: hashlib.sha256(v).hexdigest()[:16] for k, v in data.items()}
        same = len(set(sums.values())) == 1
        ok = ok and same
        print(f"tick {t} ({t // TICKS_PER_MINUTE} min): " + "  ".join(f"{k} {s} ({len(data[k])} B)" for k, s in sums.items())
              + ("  identical" if same else "  DIFFERENT"))
        for k in ("B", "C"):
            if sums[k] != sums["A"]:
                i, x, y = first_difference(data["A"], data[k])
                print(f"  A vs {k}: first difference at byte {i}\n    A: {x!r}\n    {k}: {y!r}")
    print("determinism: PASS" if ok else "determinism: FAIL")
    return ok


if __name__ == "__main__":
    main()
