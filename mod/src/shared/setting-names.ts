// Single source of truth for setting names, shared by the settings and runtime stages.
export const Settings = {
  factionCount: "rival-engineers-faction-count",
  crewSize: "rival-engineers-crew-size",
  controllerStepsPerTick: "rival-engineers-controller-steps-per-tick",
  stuckTicks: "rival-engineers-stuck-ticks",
  maxRepaths: "rival-engineers-max-repaths",
  actionStallTicks: "rival-engineers-action-stall-ticks",
  debugTeleportWhenStuck: "rival-engineers-debug-teleport-when-stuck",
  debugInstantCraft: "rival-engineers-debug-instant-craft",
  debugReachMultiplier: "rival-engineers-debug-reach-multiplier",
  jobMaxAttempts: "rival-engineers-job-max-attempts",
  jobRetryTicks: "rival-engineers-job-retry-ticks",
  batchMaxJobs: "rival-engineers-batch-max-jobs",
  jobBlockedRetryTicks: "rival-engineers-job-blocked-retry-ticks",
} as const
