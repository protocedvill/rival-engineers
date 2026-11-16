-- M7d.5 tap probe 2: watch the shared-mine route through the g209 repair (~minute 1149) and inspect the world at
-- the tap/trunk tiles after it. One stage = 1800 ticks = 0.5 game-min.
local stage = 0

local function dump(surface, x, y, r)
  local es = surface.find_entities_filtered({ area = { { x - r, y - r }, { x + r, y + r } } })
  local parts = {}
  for _, ent in pairs(es) do
    local extra = ""
    if ent.type == "transport-belt" or ent.type == "splitter" or ent.type == "underground-belt" then
      local ok, line = pcall(function() return ent.get_transport_line(1) end)
      if ok and line ~= nil then
        local ok2, n = pcall(function() return line.get_item_count() end)
        if ok2 then extra = " items=" .. tostring(n) end
      end
    end
    parts[#parts + 1] = string.format("%s@%.1f,%.1f d=%d%s", ent.name, ent.position.x, ent.position.y, ent.direction or 0, extra)
  end
  table.sort(parts)
  log("[tap2] area " .. x .. "," .. y .. " r=" .. r .. ": " .. table.concat(parts, " | "))
end

local function check()
  for _, p in ipairs({ { 475, -1 }, { 417, -58 } }) do
    local ok, r = pcall(remote.call, "rival-engineers", "route_debug", "1", p[1], p[2])
    local ok2, j = pcall(helpers.table_to_json, r)
    log("[tap2] route " .. p[1] .. "," .. p[2] .. " ok=" .. tostring(ok) .. " " .. (ok2 and j or tostring(r)))
  end
  local ok, r = pcall(remote.call, "rival-engineers", "check_debug", "1", "labs#2~2=>iron-plate")
  local ok2, j = pcall(helpers.table_to_json, r)
  log("[tap2] check ok=" .. tostring(ok) .. " " .. (ok2 and j or tostring(r)))
end

script.on_nth_tick(1800, function()
  stage = stage + 1
  local surface = game.surfaces.nauvis
  if stage == 1 then
    log("[tap2] stage 1 (minute ~1140.5)")
    dump(surface, 475, -1, 4)
    dump(surface, 417, -58, 4)
  end
  if stage >= 16 and stage <= 27 then
    log("[tap2] stage " .. stage .. " (minute ~" .. (1140 + stage / 2) .. ")")
    dump(surface, 475, -1, 4)
    dump(surface, 417, -58, 4)
    if stage == 20 or stage == 24 or stage == 26 then check() end
  end
end)
