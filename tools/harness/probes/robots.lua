-- M7d.5 probe: every 5 game-minutes, each rival force's construction-robot network, robot items in chests/roboports,
-- ghosts, deconstruction orders and passive-provider upgrades; every probe also counts `robot-built`/`robot-removed`
-- board events since the previous one ("[probe-robots]" lines).
local last = {}

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
        log(string.format("[probe-robots] t=%d %s %s networks=%d robots=%d available=%d roboports=%d inRoboports=%d chestRobots=%d chestRoboports=%d ghosts=%d decon=%d providers=%d buffers=%d built=%d removed=%d",
          e.tick, force.name, s.name, networks, all, avail, #ports, inPorts, chestRobots, chestPorts, ghosts, decon, providers, buffers, built, removed))
      end
    end
  end
end)
