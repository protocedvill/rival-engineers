-- M7d.5 probe: the pocket where the crew is boxed in building g209's pole (member at 361,16; pole at 363.5,17.5).
local done = false
script.on_nth_tick(1, function()
  if done then return end
  done = true
  local s = game.surfaces[1]
  for _, e in pairs(s.find_entities_filtered({ area = { left_top = { x = 356, y = 10 }, right_bottom = { x = 371, y = 24 } } })) do
    log(string.format("[probe-pocket] %s %s at %.1f,%.1f force=%s", tostring(e.type), e.name, e.position.x, e.position.y, e.force and e.force.name or "-"))
  end
end)
