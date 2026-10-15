// All persistent state lives in `storage` (SPEC §5.6). Every key is initialised here.
export function initStorage(): void {
  storage.pathRequests ??= {}
  storage.configOverrides ??= {}
  storage.controllers ??= {}
  storage.controllerOrder ??= []
  storage.schedulerCursor ??= 0
  storage.nextControllerId ??= 1
  storage.actions ??= {}
  storage.nextActionId ??= 1
  storage.factions ??= {}
  storage.factionOrder ??= []
  storage.crew ??= {}
  storage.nextCrewId ??= 1
}
