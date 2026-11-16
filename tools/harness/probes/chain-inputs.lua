-- M7d.5 probe: why the robot chain is starved. Logs the chain machines' status/contents, every belt/splitter around the
-- n464 iron feed (350,-41), and the remote edge/route/build checks for n464.
local done = false
local function items(inv)
  if inv == nil then return "" end
  local ok, list = pcall(function() return inv.get_contents() end)
  if not ok or list == nil then return "" end
  local parts = {}
  for _, it in pairs(list) do parts[#parts + 1] = it.name .. "=" .. it.count end
  table.sort(parts)
  return table.concat(parts, ",")
end
local function fluids(e)
  local ok, t = pcall(function() return e.get_fluid_contents() end)
  if not ok or t == nil then return "" end
  local parts = {}
  for name, amount in pairs(t) do parts[#parts + 1] = name .. "=" .. math.floor(amount) end
  table.sort(parts)
  return table.concat(parts, ",")
end
local function belt(e)
  local a, b = "", ""
  local ok1, l1 = pcall(function() return e.get_transport_line(1).get_contents() end)
  local ok2, l2 = pcall(function() return e.get_transport_line(2).get_contents() end)
  if ok1 and l1 then for _, it in pairs(l1) do a = a .. it.name .. "=" .. it.count .. ";" end end
  if ok2 and l2 then for _, it in pairs(l2) do b = b .. it.name .. "=" .. it.count .. ";" end end
  return "L1[" .. a .. "] L2[" .. b .. "]"
end

script.on_nth_tick(601, function(e)
  if done then return end
  done = true
  local s = game.surfaces[1]
  for _, force in pairs(game.forces) do
    if force.name:find("^rival") then
      -- chain machines
      for _, m in pairs(s.find_entities_filtered{ force = force, type = "assembling-machine" }) do
        local r = m.get_recipe()
        if r ~= nil and (r.name:find("battery") or r.name:find("sulfuric%-acid") or r.name:find("electric%-engine") or r.name:find("flying%-robot%-frame") or r.name:find("construction%-robot") or r.name:find("roboport") or r.name:find("sulfur") or r.name:find("engine%-unit") or r.name:find("plastic") or r.name:find("advanced%-circuit")) then
          log(string.format("[probe-chain] %s@%.1f,%.1f status=%s in[%s] out[%s] fluid[%s]", r.name, m.position.x, m.position.y, tostring(m.status),
            items(m.get_inventory(defines.inventory.crafter_input)), items(m.get_inventory(defines.inventory.crafter_output)), fluids(m)))
        end
      end
      -- belts and splitters around the n464 feed and the acid rows
      local areas = { { left_top = { x = 355, y = -102 }, right_bottom = { x = 390, y = -74 } }, { left_top = { x = 398, y = 20 }, right_bottom = { x = 415, y = 38 } }, { left_top = { x = 415, y = -30 }, right_bottom = { x = 435, y = -14 } } }
      for _, area in pairs(areas) do
        for _, b in pairs(s.find_entities_filtered{ force = force, area = area, type = { "transport-belt", "underground-belt", "splitter" } }) do
          local extra = ""
          if b.type == "splitter" then extra = string.format(" filter=%s inPrio=%s outPrio=%s", tostring(b.splitter_filter and b.splitter_filter.name or "-"), tostring(b.splitter_input_priority), tostring(b.splitter_output_priority)) end
          log(string.format("[probe-chain] %s@%.1f,%.1f dir=%s %s%s", b.name, b.position.x, b.position.y, tostring(b.direction), belt(b), extra))
        end
      end
      for _, what in pairs({ "edge", "route", "check" }) do
        local ok, d
        if what == "edge" then ok, d = pcall(remote.call, "rival-engineers", "edge_debug", "1", "n464")
        elseif what == "route" then ok, d = pcall(remote.call, "rival-engineers", "route_debug", "1", 350, -41)
        else ok, d = pcall(remote.call, "rival-engineers", "check_debug", "1", "n464") end
        if ok and d ~= nil then log("[probe-chain] " .. what .. " " .. serpent.line(d)) else log("[probe-chain] " .. what .. " " .. tostring(ok) .. " " .. tostring(d)) end
      end
    end
  end
end)
