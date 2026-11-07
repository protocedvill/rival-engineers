# Lua VM benchmark: T1 (Lua 5.4) vs Factorio (Lua 5.2)

T1 runs on the host's plain Lua (5.4 here); Factorio 2.0 embeds Lua 5.2. The planner indexes its maps with `tkey`
(`(x+OFF)*SPAN + (y+OFF)`, ~2×10^12), and large numeric table keys are dramatically slower in Factorio's Lua.

Run the same workloads in both:

```bash
lua tools/harness/lua-bench/bench.lua

# In Factorio: make a throwaway write-data dir with this mod, then --create a map; on_init logs the profiler results.
mkdir -p /tmp/lua-bench/mods && cp -r tools/harness/lua-bench/mods/lua-bench /tmp/lua-bench/mods/
printf '[path]\nread-data=<repo>/.factorio-test/factorio/data\nwrite-data=/tmp/lua-bench/data\n' > /tmp/lua-bench/config.ini
printf '{"mods":[{"name":"base","enabled":true},{"name":"lua-bench","enabled":true}]}\n' > /tmp/lua-bench/mods/mod-list.json
.factorio-test/factorio/bin/x64/factorio -c /tmp/lua-bench/config.ini --mod-directory /tmp/lua-bench/mods \
  --create /tmp/lua-bench/map.zip --map-gen-settings .factorio-test/factorio/data/map-gen-settings.example.json --map-gen-seed 1
```

Measured 2026-11-07 (same machine):

| workload | Lua 5.4 | Factorio Lua 5.2 | ratio |
|---|---|---|---|
| calls (1M) | 0.030 s | 0.047 s | 1.6× |
| `tkey` keys (~2×10^12, 200k) | 0.285 s | 7.73 s | **27×** |
| small keys (~10^6, 200k) | 0.061 s | 0.201 s | 3.3× |
| arithmetic only | 0.013 s | 0.012 s | 1× |

The planner’s hot tables (`occ`, `reserved`, `routeOcc`, terrain chunks, claims) use `tkey` values, so T1 timings
understate in-game key-heavy work by up to this factor. The in-game profiler confirms the engine is not the cause:
the `terrain` part is ~0.02 ms/tick while the `planner` part is ~11.6 ms/tick.

A future change can make the layout/terrain keys small (a layout origin, or a local fast path with a one-time rekey
migration); the microbenchmark then measures the win. Keep T1's Lua 5.4 result as a lower bound, not as the game's
cost.
