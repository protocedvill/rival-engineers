-- Debug probe (soak.py --helper-lua tools/harness/probes/status.lua): 10 game-seconds after load, and every game-minute
-- after, logs every machine of every rival force with its status and contents ("[probe]" lines in factorio-current.log).
local status_names = {}
for k, v in pairs(defines.entity_status) do status_names[v] = k end
local function contents(inv)
  if not inv then return "" end
  local parts = {}
  for _, it in pairs(inv.get_contents()) do parts[#parts + 1] = it.name .. "=" .. it.count end
  return table.concat(parts, ",")
end
local function probe()
  for _, force in pairs(game.forces) do
    if force.name:find("^rival") then
      for _, surface in pairs(game.surfaces) do
        local es = surface.find_entities_filtered({ force = force, type = { "assembling-machine", "lab", "furnace", "mining-drill", "boiler", "generator", "inserter", "offshore-pump" } })
        for _, e in pairs(es) do
          local extra = ""
          if e.type == "assembling-machine" then
            extra = " recipe=" .. (e.get_recipe() and e.get_recipe().name or "none") .. " in[" .. contents(e.get_inventory(defines.inventory.crafter_input)) .. "] out[" .. contents(e.get_inventory(defines.inventory.crafter_output)) .. "]"
          elseif e.type == "lab" then
            extra = " packs[" .. contents(e.get_inventory(defines.inventory.lab_input)) .. "]"
          elseif e.type == "furnace" then
            extra = " in[" .. contents(e.get_inventory(defines.inventory.crafter_input)) .. "] out[" .. contents(e.get_inventory(defines.inventory.crafter_output)) .. "] fuel[" .. contents(e.get_fuel_inventory()) .. "]"
          elseif e.type == "inserter" then
            extra = " dir=" .. e.direction .. " hand=" .. (e.held_stack.valid_for_read and e.held_stack.name or "-")
          end
          log(string.format("[probe] t=%d %s %s @%.1f,%.1f %s%s", game.tick, force.name, e.name, e.position.x, e.position.y, status_names[e.status or -1] or "?", extra))
        end
      end
    end
  end
end
local first
script.on_event(defines.events.on_tick, function(ev)
  first = first or ev.tick
  if ev.tick == first + 600 or (ev.tick - first) % 3600 == 0 and ev.tick > first then probe() end
end)
