-- Debug probe (soak.py --helper-lua tools/harness/probes/power.lua): every 5 game-minutes, for each rival force, log
-- every machine with no/low power and the poles near it: actual electric network, wire connection count and whether the
-- pole's supply area covers the machine. Also log pole ghosts and what stands on their tile. Diagnoses a module the
-- layout says is powered ("the layout's poles reach it") while the game leaves it dark (B47, B67).
local status_names = {}
for k, v in pairs(defines.entity_status) do status_names[v] = k end

local function network(e)
  local id = e.electric_network_id
  return id and tostring(id) or "-"
end

local function pole_info(p)
  local c = p.get_wire_connector(defines.wire_connector_id.pole_copper, false)
  return string.format("%s@%.1f,%.1f net=%s wires=%d", p.name, p.position.x, p.position.y, network(p),
    c and c.connection_count or -1)
end

local function covers(p, e)
  local proto = prototypes.entity[p.name]
  local d = proto and proto.get_supply_area_distance and proto.get_supply_area_distance() or 2.5
  local b = e.bounding_box
  return b.right_bottom.x > p.position.x - d and b.left_top.x < p.position.x + d
    and b.right_bottom.y > p.position.y - d and b.left_top.y < p.position.y + d
end

local function probe()
  local surface = game.surfaces[1]
  for _, force in pairs(game.forces) do
    if force.name:find("^rival") then
      local dark = {}
      for _, e in pairs(surface.find_entities_filtered({ force = force,
          type = { "mining-drill", "furnace", "assembling-machine", "lab", "boiler", "generator", "inserter", "offshore-pump" } })) do
        local st = status_names[e.status or -1] or "?"
        if st == "no_power" or st == "low_power" or st == "not_plugged_in_electric_network" then dark[#dark + 1] = e end
      end
      for _, e in pairs(dark) do
        local near = {}
        for _, p in pairs(surface.find_entities_filtered({ force = force, type = "electric-pole", position = e.position, radius = 12 })) do
          near[#near + 1] = { p = p, d = (p.position.x - e.position.x) ^ 2 + (p.position.y - e.position.y) ^ 2 }
        end
        table.sort(near, function(a, b) return a.d < b.d end)
        local parts = {}
        for i = 1, math.min(4, #near) do
          local n = near[i]
          parts[#parts + 1] = string.format("%s d=%.1f cover=%s", pole_info(n.p), math.sqrt(n.d), tostring(covers(n.p, e)))
        end
        log(string.format("[probe-power] t=%d %s %s@%.1f,%.1f status=%s net=%s near=[%s]", game.tick, force.name, e.name,
          e.position.x, e.position.y, status_names[e.status or -1] or "?", network(e), table.concat(parts, "; ")))
      end
      for _, g in pairs(surface.find_entities_filtered({ force = force, type = "entity-ghost", ghost_name = "small-electric-pole" })) do
        local hits = {}
        for _, o in pairs(surface.find_entities_filtered({ area = g.bounding_box })) do
          if o ~= g then hits[#hits + 1] = string.format("%s/%s/%s@%.1f,%.1f", o.name, o.type, o.force.name, o.position.x, o.position.y) end
        end
        if #hits > 0 then
          log(string.format("[probe-power] t=%d %s pole-ghost@%.1f,%.1f hits=[%s]", game.tick, force.name,
            g.position.x, g.position.y, table.concat(hits, ";")))
        end
      end
    end
  end
end

script.on_nth_tick(18000, function(e)
  probe()
end)
