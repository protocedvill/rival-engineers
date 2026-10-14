-- /re-export-library: write the calling player's blueprint library ("My blueprints" shelf) to
-- script-output/re-library/. Each top-level record becomes <index>.txt holding its export string
-- (books export whole), and index.json lists index, type and label.
--
-- LuaPlayer.blueprints only reflects the real library for a local player in the graphical client,
-- so run this in single player from the normal game, not on a headless server. Read-only.

local function export(cmd)
  local player = game.get_player(cmd.player_index)
  if not player then return end
  local index = {}
  local ok_count, failed = 0, 0
  for i, record in pairs(player.blueprints) do
    local ok, s = pcall(function() return record.export_record() end)
    local entry = { index = i, type = record.type, label = record.label }
    if ok and s then
      helpers.write_file("re-library/" .. i .. ".txt", s, false, player.index)
      ok_count = ok_count + 1
    else
      entry.error = tostring(s)
      failed = failed + 1
    end
    index[#index + 1] = entry
  end
  helpers.write_file("re-library/index.json", helpers.table_to_json(index), false, player.index)
  player.print("re-library-export: wrote " .. ok_count .. " records (" .. failed ..
    " failed) to script-output/re-library/")
end

commands.add_command("re-export-library", "Export your blueprint library as strings to script-output/re-library/",
  export)
