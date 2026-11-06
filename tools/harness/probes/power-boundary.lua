-- M7d.5 probe: at the first tick, each rival force's electric networks, its robot-chain machines and the nearest poles of
-- another network. Finds the gap when the layout says the poles reach a machine but the game leaves it dark (B67).
local done = false
script.on_nth_tick(1, function()
  if done then return end
  done = true
  local s = game.surfaces[1]
  for _, force in pairs(game.forces) do
    if force.name:find("^rival") then
      local poles = s.find_entities_filtered{ force = force, type = "electric-pole" }
      local sizes = {}
      for _, p in pairs(poles) do
        local n = p.electric_network_id or -1
        sizes[n] = (sizes[n] or 0) + 1
      end
      for n, c in pairs(sizes) do log(string.format("[probe-pw] %s network %s poles=%d", force.name, tostring(n), c)) end
      local function near(e)
        local best = {}
        for _, p in pairs(poles) do
          local n = p.electric_network_id or -1
          if n ~= (e.electric_network_id or -1) then
            local d = math.abs(p.position.x - e.position.x) + math.abs(p.position.y - e.position.y)
            if best[n] == nil or d < best[n].d then best[n] = { p = p, d = d } end
          end
        end
        local parts = {}
        for n, b in pairs(best) do parts[#parts + 1] = string.format("net%s@%.1f,%.1f d=%.1f", tostring(n), b.p.position.x, b.p.position.y, b.d) end
        table.sort(parts)
        return table.concat(parts, "; ")
      end
      for _, e in pairs(s.find_entities_filtered{ force = force, type = "assembling-machine" }) do
        local r = e.get_recipe()
        if r ~= nil and (r.name:find("battery") or r.name:find("sulfuric%-acid") or r.name:find("electric%-engine") or r.name:find("flying%-robot%-frame") or r.name:find("construction%-robot") or r.name:find("roboport")) then
          log(string.format("[probe-pw] %s %s@%.1f,%.1f net=%s status=%s other=[%s]", force.name, r.name, e.position.x, e.position.y,
            tostring(e.electric_network_id), tostring(e.status), near(e)))
        end
      end
    end
  end
end)
