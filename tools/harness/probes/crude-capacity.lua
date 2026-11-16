-- M7d.5 probe: built pumpjacks, their crude/s from the resource under each, and the graph's planned crude demand.
local done = false
local function rate(amount)
  local res = prototypes.entity["crude-oil"]
  local p = res.mineable_properties.products[1]
  local normal = res.normal_resource_amount or 10000
  local time = res.mineable_properties.mining_time or 1
  local speed = prototypes.entity["pumpjack"] and prototypes.entity["pumpjack"].mining_speed or 1
  return (p.amount or 10) * speed * (amount / normal) / time
end
script.on_nth_tick(1, function()
  if done then return end
  done = true
  local s = game.surfaces[1]
  for _, force in pairs(game.forces) do
    if force.name:find("^rival") then
      local pumps = s.find_entities_filtered{ force = force, type = "mining-drill", name = "pumpjack" }
      local total, low = 0, 0
      for _, e in pairs(pumps) do
        local amount = 0
        for _, r in pairs(s.find_entities_filtered{ area = e.bounding_box, type = "resource", name = "crude-oil" }) do
          if math.floor(r.position.x) == math.floor(e.position.x) and math.floor(r.position.y) == math.floor(e.position.y) then amount = r.amount end
        end
        local r = rate(amount)
        total = total + r
        if amount > 0 and r < 0.05 then low = low + 1 end
        log(string.format("[probe-crude] pumpjack@%.1f,%.1f amount=%d rate=%.4f/s status=%s", e.position.x, e.position.y, amount, r, tostring(e.status)))
      end
      -- Crude tiles in the two field regions we know about.
      local far = s.find_entities_filtered{ area = { left_top = { x = 1000, y = -800 }, right_bottom = { x = 1700, y = -200 } }, type = "resource", name = "crude-oil" }
      local near = s.find_entities_filtered{ area = { left_top = { x = -600, y = -600 }, right_bottom = { x = 700, y = 400 } }, type = "resource", name = "crude-oil" }
      log(string.format("[probe-crude] pumpjacks=%d total=%.3f/s low=%d farCrudeTiles=%d nearCrudeTiles=%d", #pumps, total, low, #far, #near))
      local ok, d = pcall(remote.call, "rival-engineers", "edge_debug", "1", "crude")
      local demand, n = 0, 0
      if ok and d ~= nil and d.edges ~= nil then
        for _, e in pairs(d.edges) do
          if e.item == "crude-oil" then
            demand = demand + (e.planned or 0)
            n = n + 1
          end
        end
      end
      log(string.format("[probe-crude] crudeEdges=%d plannedDemand=%.3f/s edgesOk=%s", n, demand, tostring(ok)))
    end
  end
end)
