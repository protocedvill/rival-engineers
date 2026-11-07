-- M7d.5 probe: every ghost with its plan key and place job (remote `ghost_debug`), for leftover-ghost checks.
-- `planned=no` is an orphan (no plan part); `job=none` is a planned ghost nothing will build (B152).
local done = false
script.on_nth_tick(1, function()
  if done then return end
  done = true
  for _, force in pairs(game.forces) do
    if force.name:find("^rival") then
      local faction = force.name:gsub("^rival%-", "")
      local ok, out = pcall(remote.call, "rival-engineers", "ghost_debug", faction)
      log("[probe-ghost] " .. tostring(ok) .. "\n" .. tostring(out))
    end
  end
end)
