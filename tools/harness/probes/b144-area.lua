-- B144 probe: dump what stands on the blocked lane near 357,11..17, at the first tick after load and 10 s later.
-- Run with: soak.py --helper-lua tools/harness/probes/b144-area.lua --from-save <min-0660>
local function dump(tick)
  local s = game.surfaces[1]
  local area = { left_top = { x = 352, y = 6 }, right_bottom = { x = 364, y = 20 } }
  local force
  for _, f in pairs(game.forces) do
    if f.name ~= "player" and f.name ~= "neutral" then force = f break end
  end
  for _, o in pairs(s.find_entities_filtered{ area = area }) do
    local ghost = (o.type == "entity-ghost") and o.ghost_name or ""
    log(string.format("[probe-b144] tick=%d %s type=%s force=%s pos=%.1f,%.1f dir=%s ghost=%s", tick, o.name, o.type, o.force.name,
      o.position.x, o.position.y, tostring(o.direction), ghost))
  end
  for _, t in pairs(s.find_tiles_filtered{ area = area }) do
    if t.name ~= "lab-dark-1" and t.name ~= "lab-dark-2" then
      log(string.format("[probe-b144] tick=%d tile %s at %d,%d", tick, t.name, t.position.x, t.position.y))
    end
  end
  if force ~= nil then
    for y = 10, 18 do
      local ok = s.can_place_entity{ name = "transport-belt", position = { x = 357.5, y = y + 0.5 }, direction = defines.direction.north, force = force }
      local hits = s.find_entities_filtered{ position = { x = 357.5, y = y + 0.5 } }
      local names = {}
      for _, h in pairs(hits) do names[#names + 1] = h.name .. "/" .. h.type .. "/" .. h.force.name end
      log(string.format("[probe-b144] tick=%d belt at 357,%d can=%s hits=%s", tick, y, tostring(ok), table.concat(names, ",")))
    end
  end
end

local first = true
script.on_nth_tick(1, function(e)
  if first then
    first = false
    dump(e.tick)
  end
end)
script.on_nth_tick(600, function(e) dump(e.tick) end)
