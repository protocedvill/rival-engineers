-- M7d.5 probe: every own pole ghost, with its position, so an unfinished pole line is distinguishable from a layout
-- that never placed one (the robot block's electric islands).
local done = false
script.on_nth_tick(1, function()
  if done then return end
  done = true
  local s = game.surfaces[1]
  for _, force in pairs(game.forces) do
    if force.name:find("^rival") then
      local n = 0
      for _, g in pairs(s.find_entities_filtered{ force = force, type = "entity-ghost", ghost_name = "small-electric-pole" }) do
        n = n + 1
        log(string.format("[probe-poleghost] %s @%.1f,%.1f", force.name, g.position.x, g.position.y))
      end
      log(string.format("[probe-poleghost] %s total=%d", force.name, n))
      -- Every pole and its network, grouped, to see the islands next to the robot block.
      local bynet = {}
      for _, p in pairs(s.find_entities_filtered{ force = force, type = "electric-pole" }) do
        local k = p.electric_network_id or -1
        bynet[k] = (bynet[k] or 0) + 1
      end
      for k, c in pairs(bynet) do log(string.format("[probe-poleghost] %s net %s poles=%d", force.name, tostring(k), c)) end
    end
  end
end)
