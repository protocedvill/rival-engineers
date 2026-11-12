-- Debug probe (soak.py --helper-lua tools/harness/probes/board.lua): every 5 game-minutes, each faction's active jobs
-- grouped by key prefix, kind, item and target (remote board_summary): claimed / waiting on dependencies / backing off /
-- ready, how many ready ones the crew could take the materials for now, and what the crew could take ("[probe-board]"
-- lines in factorio-current.log). Diagnoses job backlogs.
script.on_nth_tick(18000, function(e)
  for name, s in pairs(remote.call("rival-engineers", "board_summary")) do
    log(string.format("[probe-board] tick=%d faction=%s crew=%d active=%d available=%s", e.tick, name, s.crew, s.active, serpent.line(s.available)))
    local names = {}
    for k in pairs(s.groups) do names[#names + 1] = k end
    table.sort(names, function(a, b) return s.groups[a].jobs > s.groups[b].jobs end)
    for _, k in ipairs(names) do
      local g = s.groups[k]
      log(string.format("[probe-board] tick=%d   %-50s jobs=%d claimed=%d deps=%d backoff=%d ready=%d stocked=%d prio=%d maxAge=%d need=%s samples=%s",
        e.tick, k, g.jobs, g.claimed, g.deps, g.backoff, g.ready, g.readyStocked, g.priority, g.maxAge, serpent.line(g.need), serpent.line(g.samples)))
    end
  end
end)
