-- Debug probe (soak.py --helper-lua tools/harness/probes/water.lua): logs the surface's map-gen starting points, the
-- nearest water to each rival force's first character at its first sighting, and every offshore pump and belt count
-- per force each 5 game-minutes ("[water]" lines in factorio-current.log).
local seen = {}
local function nearest_water(surface, p, r)
  local tiles = surface.find_tiles_filtered({ area = { { p.x - r, p.y - r }, { p.x + r, p.y + r } }, collision_mask = "water_tile" })
  local best, bp = math.huge, nil
  for _, t in pairs(tiles) do
    local d = math.sqrt((t.position.x - p.x) ^ 2 + (t.position.y - p.y) ^ 2)
    if d < best then best, bp = d, t.position end
  end
  return #tiles, best, bp
end
local function probe(tick)
  local s = game.surfaces[1]
  log("[water] t=" .. tick .. " starting_points=" .. serpent.line(s.map_gen_settings.starting_points))
  for _, force in pairs(game.forces) do
    if force.name:find("^rival") then
      if not seen[force.name] then
        local chars = s.find_entities_filtered({ type = "character", force = force })
        if chars[1] then
          seen[force.name] = chars[1].position
          local n, d, bp = nearest_water(s, chars[1].position, 200)
          log(string.format("[water] %s at %.0f,%.0f: %d water tiles within 200, nearest %.0f at %s", force.name, chars[1].position.x, chars[1].position.y, n, d, serpent.line(bp)))
        end
      end
      for _, e in pairs(s.find_entities_filtered({ force = force, name = "offshore-pump" })) do
        log(string.format("[water] %s offshore-pump @%.1f,%.1f", force.name, e.position.x, e.position.y))
      end
    end
  end
end
local first
script.on_event(defines.events.on_tick, function(ev)
  first = first or ev.tick
  if ev.tick == first + 60 or (ev.tick - first) % 18000 == 0 and ev.tick > first then probe(ev.tick) end
end)
