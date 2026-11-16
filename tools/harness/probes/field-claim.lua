-- M7d.5 probe: why the fixed field box at (1390,-522) cannot be placed. Calls the mod's claim_debug (planner claims are
-- data, not entities), then reports the trees/rocks around the tile (those are clearable; claims are not).
local done = false
script.on_nth_tick(1, function()
  if done then return end
  done = true
  local X, Y = 1390, -522
  local ok, d = pcall(remote.call, "rival-engineers", "claim_debug", "rival-engineers-1", X, Y, 40)
  log(string.format("[probe-field] claim_debug ok=%s", tostring(ok)))
  if ok and type(d) == "table" then
    for _, m in pairs(d.covering or {}) do
      log(string.format("[probe-field] COVERS id=%s gen=%s rect=%d,%d %dx%d wells=%s", tostring(m.id), tostring(m.generator), m.rect.x, m.rect.y, m.rect.w, m.rect.h, tostring(m.wells)))
    end
    for _, c in pairs(d.claims or {}) do
      log(string.format("[probe-field] claim %d,%d %s=%s", c.x, c.y, c.index, tostring(c.owner)))
    end
  end
  local s = game.surfaces[1]
  local around = { left_top = { x = X - 20, y = Y - 20 }, right_bottom = { x = X + 21, y = Y + 21 } }
  local trees = s.find_entities_filtered({ area = around, type = "tree" })
  local rocks = s.find_entities_filtered({ area = around, type = "simple-entity" })
  local atTile = s.find_entities_filtered({ area = { left_top = { x = X, y = Y }, right_bottom = { x = X + 1, y = Y + 1 } } })
  local names = {}
  for _, e in pairs(atTile) do names[#names + 1] = e.name end
  local crude = s.find_entities_filtered({ area = around, type = "resource", name = "crude-oil" })
  log(string.format("[probe-field] around20 trees=%d rocks=%d crudeTiles=%d atOrigin=%s", #trees, #rocks, #crude, table.concat(names, ",")))
end)
