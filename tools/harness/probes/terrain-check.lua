-- Diagnostic: actual terrain between the base and the remote crude field at (1383,-541).
local done = false
script.on_event(defines.events.on_tick, function(e)
  if done or e.tick < 120 then return end
  done = true
  local s = game.surfaces.nauvis
  if s == nil then return end
  local function tile(x, y)
    local ok, t = pcall(function() return s.get_tile(math.floor(x), math.floor(y)) end)
    if not ok or t == nil then return "?" end
    return t.name
  end
  local function isWater(x, y) return tile(x, y):find("water") ~= nil or tile(x, y) == "deepwater" end
  -- Straight sample base -> field, every 16 tiles.
  local bx, by, fx, fy = 508, -88, 1383, -541
  local parts = {}
  for i = 0, 60 do
    local x = bx + (fx - bx) * i / 60
    local y = by + (fy - by) * i / 60
    parts[#parts + 1] = string.format("%d,%d=%s", math.floor(x), math.floor(y), tile(x, y))
  end
  log("[terrain-check] line " .. table.concat(parts, " "))
  -- Water/cliff counts in a 600x600 box around the field and around the base.
  for _, box in ipairs({ { fx - 300, fy - 300, 600, "field" }, { bx - 300, by - 300, 600, "base" } }) do
    local x, y, w, label = box[1], box[2], box[3], box[4]
    local water, cliff, land = 0, 0, 0
    for sy = y, y + w - 1, 8 do
      for sx = x, x + w - 1, 8 do
        local t = tile(sx, sy)
        if t:find("water") ~= nil or t == "deepwater" then water = water + 1
        elseif t == "cliff" then cliff = cliff + 1
        else land = land + 1 end
      end
    end
    log(string.format("[terrain-check] %s box %d,%d %dx%d water=%d cliff=%d land=%d", label, x, y, w, w, water, cliff, land))
  end
  -- Local field map, 80x80 around it, rows of water/land/cliff.
  for yy = fy - 40, fy + 40, 8 do
    local row = {}
    for xx = fx - 40, fx + 40, 8 do
      local t = tile(xx, yy)
      row[#row + 1] = (t:find("water") ~= nil or t == "deepwater") and "~" or (t == "cliff" and "C" or ".")
    end
    log(string.format("[terrain-check] field y=%d %s", yy, table.concat(row)))
  end
end)
