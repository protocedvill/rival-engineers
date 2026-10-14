-- Dumps all built (non-neutral, non-enemy) entities of the first surface to JSON.
-- Runs once in on_init, which fires when this mod is added to an existing save.
-- Output: script-output/re-save-dump.json in the write-data dir.
-- Format is a superset of mod/src/remote.ts dumpEntities, so tools/render/render.py can draw it.

local SKIP_FORCES = { neutral = true, enemy = true }

local function recipe_of(e)
  if e.type == "assembling-machine" or e.type == "furnace" or e.type == "rocket-silo" then
    local ok, r = pcall(function() return e.get_recipe() end)
    if ok and r then return r.name end
    if e.type == "furnace" then
      local ok2, prev = pcall(function() return e.previous_recipe end)
      if ok2 and prev then
        local n = prev.name
        if type(n) ~= "string" and n then n = n.name end
        return n
      end
    end
  end
  return nil
end

local function pos(p) return { x = p.x, y = p.y } end

local function dump()
  local surface = game.surfaces[1]
  local out = {}
  for _, force in pairs(game.forces) do
    if not SKIP_FORCES[force.name] then
      for _, e in pairs(surface.find_entities_filtered({ force = force })) do
        if e.valid and e.type ~= "character" then
          local proto = e.prototype
          local box = proto.collision_box
          local sideways = e.direction == defines.direction.east or e.direction == defines.direction.west
          local rec = {
            name = e.name, type = e.type,
            x = e.position.x, y = e.position.y,
            direction = e.direction, force = force.name,
            w = box.right_bottom.x - box.left_top.x,
            h = box.right_bottom.y - box.left_top.y,
            tw = sideways and proto.tile_height or proto.tile_width,
            th = sideways and proto.tile_width or proto.tile_height,
          }
          rec.recipe = recipe_of(e)
          if e.type == "underground-belt" then rec.belt_to_ground_type = e.belt_to_ground_type end
          if e.type == "inserter" then
            rec.pickup = pos(e.pickup_position)
            rec.drop = pos(e.drop_position)
          end
          if e.type == "mining-drill" and e.mining_target and e.mining_target.valid then
            rec.mining = e.mining_target.name
          end
          if e.type == "transport-belt" or e.type == "underground-belt" or e.type == "splitter" then
            -- Items currently on the belt tell us what it carries.
            local items = {}
            for line = 1, e.get_max_transport_line_index() do
              local tl = e.get_transport_line(line)
              for _, c in pairs(tl.get_contents()) do items[c.name] = (items[c.name] or 0) + c.count end
            end
            if next(items) then rec.items = items end
          end
          out[#out + 1] = rec
        end
      end
    end
  end
  local center = { x = 0, y = 0 }
  local radius = 0
  for _, r in pairs(out) do
    radius = math.max(radius, math.abs(r.x), math.abs(r.y))
  end
  -- Recipe and machine data for everything referenced, so offline tools need no prototype dump.
  local recipes, machines = {}, {}
  for _, r in pairs(out) do
    if r.recipe and not recipes[r.recipe] and prototypes.recipe[r.recipe] then
      local p = prototypes.recipe[r.recipe]
      recipes[r.recipe] = { energy = p.energy, category = p.category, ingredients = p.ingredients, products = p.products }
    end
    if (r.type == "assembling-machine" or r.type == "furnace") and not machines[r.name] then
      machines[r.name] = { crafting_speed = prototypes.entity[r.name].get_crafting_speed() }
    end
  end
  helpers.write_file("re-save-dump.json",
    helpers.table_to_json({ tick = game.tick, center = center, radius = math.ceil(radius) + 2, entities = out,
      recipes = recipes, machines = machines }), false)
  log("re-save-dump: wrote " .. #out .. " entities")
end

-- Static prototype data (all recipes, crafting speeds, entity tile sizes) so blueprints from other
-- sources can be clustered offline too. Independent of the save's contents.
local function dump_prototypes()
  local recipes, machines, sizes = {}, {}, {}
  for name, p in pairs(prototypes.recipe) do
    recipes[name] = { energy = p.energy, category = p.category, ingredients = p.ingredients, products = p.products }
  end
  for name, p in pairs(prototypes.entity) do
    if p.tile_width and p.tile_width > 0 and p.type ~= "tile-ghost" then
      sizes[name] = { type = p.type, tw = p.tile_width, th = p.tile_height }
      if p.type == "assembling-machine" or p.type == "furnace" then
        machines[name] = { crafting_speed = p.get_crafting_speed() }
      end
    end
  end
  helpers.write_file("re-prototypes.json",
    helpers.table_to_json({ recipes = recipes, machines = machines, sizes = sizes }), false)
end

script.on_init(function()
  dump()
  dump_prototypes()
end)


