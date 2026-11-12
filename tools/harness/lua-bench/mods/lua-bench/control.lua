-- Lua VM microbenchmarks: run inside Factorio (Lua 5.2) and under plain Lua 5.4 (bench.lua). Run at map creation; each
-- workload gets its own LuaProfiler so the engine's own update time is not included.
local OFF = 1048576
local function keys(mult)
  local t = {}
  for i=1,200000 do local x=i%500; local y=(i-x)/500; t[(x+OFF)*mult+(y+OFF)]=i end
  local s=0
  for i=1,200000 do local x=i%500; local y=(i-x)/500; s=s+(t[(x+OFF)*mult+(y+OFF)] or 0) end
  return s
end
local function calls()
  local function f(a) return a + 1 end
  local s = 0
  for i=1,1000000 do s = f(s) end
  return s
end
local function arith()
  local s = 0
  for i=1,1000000 do s = s + (i * 2097152 + 1048576) % 7 end
  return s
end
local function run(name, fn)
  local p = helpers.create_profiler()
  p.restart()
  local s = fn()
  p.stop()
  log({"", "[lua-bench] "..name.." ", p, " s="..tostring(s)})
end
script.on_init(function()
  run("tkey_2e12", function() return keys(2097152) end)
  run("small_1e6", function() return keys(1000000) end)
  run("calls", calls)
  run("arith", arith)
end)
