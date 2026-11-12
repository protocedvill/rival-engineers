-- M7d.5 benchmark gate: the robots.lua probe plus an early stop. Every 5 game-minutes log the network, robot items,
-- ghosts and chain rows; the first time a network holds a construction robot (or a roboport holds one), write
-- done.json so soak.py stops the run at the robot gate instead of the game-hour cap.
local last = {}
local gate = false

local function count(inv, name)
  if inv == nil then return 0 end
  return inv.get_item_count(name)
end

script.on_nth_tick(18000, function(e)
  for _, force in pairs(game.forces) do
    if force.name:find("^rival") then
      for _, s in pairs(game.surfaces) do
        local nets = force.logistic_networks[s.name] or {}
        local networks, all, avail = 0, 0, 0
        for _, net in pairs(nets) do
          networks = networks + 1
          all = all + (net.all_construction_robots or 0)
          avail = avail + (net.available_construction_robots or 0)
        end
        local ports = s.find_entities_filtered{ force = force, type = "roboport" }
        local inPorts, chestRobots, chestPorts = 0, 0, 0
        for _, p in pairs(ports) do
          inPorts = inPorts + count(p.get_inventory(defines.inventory.roboport_robot), "construction-robot")
        end
        for _, c in pairs(s.find_entities_filtered{ force = force, type = "logistic-container" }) do
          local inv = c.get_inventory(defines.inventory.chest)
          chestRobots = chestRobots + count(inv, "construction-robot")
          chestPorts = chestPorts + count(inv, "roboport")
        end
        local status_names = {}
        for k, v in pairs(defines.entity_status) do status_names[v] = k end
        local chain = {}
        for _, m in pairs(s.find_entities_filtered{ force = force, type = "assembling-machine" }) do
          local recipe = m.get_recipe()
          if recipe ~= nil and (recipe.name:find("electric%-engine") or recipe.name:find("battery") or recipe.name:find("sulfuric%-acid") or recipe.name:find("flying%-robot%-frame")) then
            local fluid = m.get_fluid_contents()
            local parts = {}
            for name, amount in pairs(fluid) do parts[#parts + 1] = name .. "=" .. math.floor(amount) end
            local key = recipe.name .. "/" .. (status_names[m.status or -1] or "?") .. "/" .. table.concat(parts, ",")
            chain[key] = (chain[key] or 0) + 1
          end
        end
        local cparts = {}
        for key, n in pairs(chain) do cparts[#cparts + 1] = key .. "x" .. n end
        table.sort(cparts)
        local ghosts = #s.find_entities_filtered{ force = force, type = "entity-ghost" }
        local decon = #s.find_entities_filtered{ force = force, to_be_deconstructed = true }
        local providers = #s.find_entities_filtered{ force = force, name = "passive-provider-chest" }
        local buffers = #s.find_entities_filtered{ force = force, name = "buffer-chest" }
        local built, removed = 0, 0
        local ok, events = pcall(remote.call, "rival-engineers", "board_events", force.name)
        if ok then
          for _, ev in pairs(events) do
            if ev.reason == "robot-built" and ev.tick > (last[force.name] or 0) then built = built + 1 end
            if ev.reason == "robot-removed" and ev.tick > (last[force.name] or 0) then removed = removed + 1 end
          end
        end
        last[force.name] = e.tick
        log(string.format("[probe-robots] t=%d %s %s networks=%d robots=%d available=%d roboports=%d inRoboports=%d chestRobots=%d chestRoboports=%d ghosts=%d decon=%d providers=%d buffers=%d built=%d removed=%d chain=%s",
          e.tick, force.name, s.name, networks, all, avail, #ports, inPorts, chestRobots, chestPorts, ghosts, decon, providers, buffers, built, removed, table.concat(cparts, ";")))
        if (all > 0 or inPorts > 0) and not gate then
          gate = true
          log(string.format("[robot-gate] REACHED t=%d %s robots=%d available=%d inRoboports=%d", e.tick, force.name, all, avail, inPorts))
          helpers.write_file("rival-engineers/done.json", string.format('{"milestone":"robot-gate","tick":%d}', e.tick))
        end
      end
    end
  end
end)
