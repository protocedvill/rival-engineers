-- M7d.5 probe: the layout's pole graph beside the built world for the robot chain (power_debug), at the first tick.
local done = false
script.on_nth_tick(1, function()
  if done then return end
  done = true
  for _, filter in pairs({ "stock", "frame", "sulfuric", "battery", "electric-engine" }) do
    local ok, text = pcall(remote.call, "rival-engineers", "power_debug", "1", filter)
    if ok then
      log(string.format("[probe-pwdbg] ==== %s ====", filter))
      for line in string.gmatch(tostring(text), "[^\n]+") do log("[probe-pwdbg] " .. line) end
    else
      log("[probe-pwdbg] error " .. tostring(text))
    end
  end
end)
