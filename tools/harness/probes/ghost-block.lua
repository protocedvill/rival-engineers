-- Debug probe (soak.py --helper-lua): every 30 game-seconds, every faction ghost that has existed for 2+ probes, with
-- what overlaps its box (entities and tiles), to explain a place job that keeps failing "cannot-place".
local seen = {}
script.on_nth_tick(1800, function(e)
  local surface = game.surfaces[1]
  for _, ghost in pairs(surface.find_entities_filtered{type = "entity-ghost"}) do
    if ghost.force.name ~= "player" and ghost.force.name ~= "neutral" then
      local id = ghost.unit_number
      seen[id] = (seen[id] or 0) + 1
      if seen[id] >= 2 then
        local box = ghost.bounding_box
        local hits = {}
        for _, o in pairs(surface.find_entities_filtered{area = box}) do
          if o ~= ghost then hits[#hits + 1] = string.format("%s/%s/%s@%.1f,%.1f", o.name, o.type, o.force.name, o.position.x, o.position.y) end
        end
        local tiles = {}
        for _, t in pairs(surface.find_tiles_filtered{area = box}) do tiles[t.name] = (tiles[t.name] or 0) + 1 end
        local can = surface.can_place_entity{name = ghost.ghost_name, position = ghost.position, direction = ghost.direction, force = ghost.force}
        log(string.format("[probe-ghost] tick=%d %s@%.1f,%.1f age=%d can=%s hits=%s tiles=%s", e.tick, ghost.ghost_name,
          ghost.position.x, ghost.position.y, seen[id], tostring(can), table.concat(hits, ";"), serpent.line(tiles)))
      end
    end
  end
end)
