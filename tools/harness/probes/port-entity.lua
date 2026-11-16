local done = false
script.on_event(defines.events.on_tick, function(e)
  if done or e.tick < 120 then return end
  done = true
  local s = game.surfaces.nauvis
  if s == nil then return end
  for _, p in ipairs({ {467.5,-165.5,"n325.in-fuel outside"}, {481.5,-151.5,"n317.in-fuel outside"}, {466.5,-165.5,"n325.in-fuel tile"} }) do
    local x,y,label=p[1],p[2],p[3]
    local found = s.find_entities_filtered{ area = { {x-1.1,y-1.1}, {x+1.1,y+1.1} } }
    local parts={}
    for _,en in pairs(found) do
      parts[#parts+1]=string.format("%s/%s/%s@%.1f,%.1f force=%s", en.name, en.type, en.ghost_name or "-", en.position.x, en.position.y, en.force.name)
    end
    log(string.format("[port-entity] %s (%s,%s): %s", label, x, y, table.concat(parts," | ")))
  end
end)
