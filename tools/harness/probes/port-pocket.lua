-- M7d.5 probe: what boxes in the water port at 405,30 (run N's robot-chain sulfur row). Prints every entity in the
-- 5x5 around the goal and the pipe/pump/belt names a little wider, so a local seal can be named.
local done = false
script.on_nth_tick(1, function()
  if done then return end
  done = true
  local s = game.surfaces[1]
  local near = { left_top = { x = 402, y = 27 }, right_bottom = { x = 409, y = 34 } }
  for _, e in pairs(s.find_entities_filtered({ area = near })) do
    log(string.format("[probe-port] %s %s at %.1f,%.1f force=%s", tostring(e.type), e.name, e.position.x, e.position.y, e.force and e.force.name or "-"))
  end
  local wide = { left_top = { x = 390, y = 20 }, right_bottom = { x = 420, y = 50 } }
  local counts = {}
  for _, e in pairs(s.find_entities_filtered({ area = wide })) do
    local k = e.type .. ":" .. e.name
    counts[k] = (counts[k] or 0) + 1
  end
  local keys = {}
  for k in pairs(counts) do keys[#keys + 1] = k end
  table.sort(keys)
  for _, k in pairs(keys) do log(string.format("[probe-port] count %s = %d", k, counts[k])) end
end)
