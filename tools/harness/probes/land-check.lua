-- Diagnostic: is the remote field at (1383,-541) on the same landmass as the base (508,-88)?
local phase = 0
script.on_event(defines.events.on_tick, function(e)
  local s = game.surfaces.nauvis
  if s == nil then return end
  if phase == 0 and e.tick >= 120 then
    phase = 1
    -- Generate the whole box once, so get_tile is real terrain.
    for cy = math.floor(-700 / 32), math.floor(-20 / 32) do
      for cx = math.floor(400 / 32), math.floor(1500 / 32) do
        s.request_to_generate_chunks({ x = cx * 32 + 16, y = cy * 32 + 16 }, 0)
      end
    end
    s.force_generate_chunk_requests()
    log("[land-check] requested generation")
    return
  end
  if phase ~= 1 or e.tick < 300 then return end
  phase = 2
  local function blocked(x, y)
    local ok, t = pcall(function() return s.get_tile(x, y) end)
    if not ok or t == nil then return true end
    local n = t.name
    return n:find("water") ~= nil or n == "deepwater" or n == "out-of-map" or n == "cliff"
  end
  local step = 1
  local x0, y0, x1, y1 = 460, -700, 1460, -20
  local w = math.floor((x1 - x0) / step) + 1
  local h = math.floor((y1 - y0) / step) + 1
  local seen = {}
  local qx, qy = {}, {}
  local function idx(ix, iy) return iy * w + ix end
  local function gx(ix) return x0 + ix * step end
  local function gy(iy) return y0 + iy * step end
  local sx, sy = math.floor((508 - x0) / step), math.floor((-88 - y0) / step)
  local tx, ty = math.floor((1383 - x0) / step), math.floor((-541 - y0) / step)
  local start = idx(sx, sy)
  seen[start] = true
  qx[1], qy[1] = sx, sy
  local head, tail = 1, 1
  local found = false
  while head <= tail do
    local ix, iy = qx[head], qy[head]; head = head + 1
    if ix == tx and iy == ty then found = true; break end
    for _, d in ipairs({ {1,0}, {-1,0}, {0,1}, {0,-1} }) do
      local nx, ny = ix + d[1], iy + d[2]
      if nx >= 0 and ny >= 0 and nx < w and ny < h then
        local ni = idx(nx, ny)
        if not seen[ni] and not blocked(gx(nx), gy(ny)) then
          seen[ni] = true
          tail = tail + 1
          qx[tail], qy[tail] = nx, ny
        end
      end
    end
  end
  local water, land = 0, 0
  for yy = y0, y1, step do for xx = x0, x1, step do if blocked(xx, yy) then water = water + 1 else land = land + 1 end end end
  log(string.format("[land-check] base(%d,%d)->field(%d,%d) connected=%s visited=%d land=%d blocked=%d box=%dx%d step=%d", gx(sx), gy(sy), gx(tx), gy(ty), tostring(found), tail, land, water, w, h, step))
  -- Print the field's local land/wate shape.
  for yy = -600, -480, 8 do
    local row = {}
    for xx = 1300, 1440, 8 do row[#row + 1] = blocked(xx, yy) and "~" or "." end
    log(string.format("[land-check] y=%d %s", yy, table.concat(row)))
  end
end)
