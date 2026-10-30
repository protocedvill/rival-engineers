-- Debug probe (soak.py --helper-lua): every 10 game-seconds, each crew member's position, claims and running action
-- (remote crew_debug), to diagnose idle or stuck crews.
script.on_nth_tick(600, function(e)
  for _, m in pairs(remote.call("rival-engineers", "crew_debug")) do
    log(string.format("[probe-crew] tick=%d %s", e.tick, serpent.line(m)))
  end
end)
