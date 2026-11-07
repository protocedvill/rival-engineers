-- The same workloads as mods/lua-bench/control.lua, for plain Lua 5.4 (T1's interpreter): lua bench.lua
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
for name, fn in pairs({ ["tkey_2e12"] = function() return keys(2097152) end, ["small_1e6"] = function() return keys(1000000) end, calls = calls, arith = arith }) do
  local t = os.clock()
  local s = fn()
  print(string.format("[lua-bench] %s %.4f s=%d", name, os.clock() - t, s))
end
