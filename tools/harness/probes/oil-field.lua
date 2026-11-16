-- M7d.5 probe: what occupies the far crude field at 1390,-522, and what the design thinks about crude capacity.
local done = false
script.on_nth_tick(1, function()
  if done then return end
  done = true
  local s = game.surfaces[1]
  local area = { left_top = { x = 1340, y = -570 }, right_bottom = { x = 1440, y = -470 } }
  for _, e in pairs(s.find_entities_filtered{ area = area }) do
    log(string.format("[probe-oil] %s type=%s force=%s @%.1f,%.1f", e.name, e.type, e.force.name, e.position.x, e.position.y))
  end
  local oil, wells = 0, 0
  for _, e in pairs(s.find_entities_filtered{ area = area, type = "resource", name = "crude-oil" }) do
    oil = oil + 1
    if wells < 12 then log(string.format("[probe-oil] crude @%.1f,%.1f amount=%s", e.position.x, e.position.y, tostring(e.amount))) end
    wells = wells + 1
  end
  log(string.format("[probe-oil] crude tiles=%d", oil))
  for _, what in pairs({ "crude-oil", "oil-complex" }) do
    local ok, d = pcall(remote.call, "rival-engineers", "design_debug", "1", what)
    if ok and d ~= nil then log("[probe-oil] design " .. what .. " " .. serpent.line(d)) else log("[probe-oil] design " .. what .. " " .. tostring(ok) .. " " .. tostring(d)) end
  end
  local ok, d = pcall(remote.call, "rival-engineers", "edge_debug", "1", "crude-oil")
  if ok and d ~= nil then log("[probe-oil] edges " .. serpent.line(d)) else log("[probe-oil] edges " .. tostring(ok) .. " " .. tostring(d)) end
end)
