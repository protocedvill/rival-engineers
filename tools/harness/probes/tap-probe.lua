-- M7d.5 tap probe: what owns the shared-mine tap tiles in the layout and the world, and what does the repair
-- check think of the trunk/tap edges? First dump at 5 s, remote checks after the factory brain has run.
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
    parts[#parts + 1] = string.format("%s(%s)@%.2f,%.2f d=%d%s", ent.name, ent.type, ent.position.x, ent.position.y, ent.direction or 0, extra)
  end
  table.sort(parts)
  log("[tap-probe] area " .. x .. "," .. y .. " r=" .. r .. ": " .. table.concat(parts, " | "))
end

local function call(label, ...)
  local ok, r = pcall(remote.call, "rival-engineers", ...)
  local text
  if ok then
    local ok2, json = pcall(helpers.table_to_json, r)
    text = ok2 and json or tostring(r)
  else
    text = tostring(r)
  end
  log("[tap-probe] " .. label .. " ok=" .. tostring(ok) .. " " .. text)
end

local function world()
  local surface = game.surfaces.nauvis
  dump(surface, 475, -1, 4)
  dump(surface, 417, -58, 4)
end

local function layout()
  call("summary", "board_summary")
  call("milestones", "milestones")
  call("design", "design_debug", "1", "power")
  for _, p in ipairs({ { 475, -1 }, { 417, -58 }, { 416, -57 }, { 474, 0 }, { 505, 1 } }) do
    call("route " .. p[1] .. "," .. p[2], "route_debug", "1", p[1], p[2])
  end
  call("check", "check_debug", "1", "labs#2~2=>iron-plate")
  call("edge", "edge_debug", "1", "labs#2~2=>iron-plate")
end

script.on_nth_tick(300, function()
  stage = stage + 1
  if stage == 1 then world() end
  if stage == 20 then
    world()
    layout()
  end
end)
