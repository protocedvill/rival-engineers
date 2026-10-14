// All persistent state lives in `storage` (SPEC §5.6). Every key is initialised here.
export function initStorage(): void {
  storage.pathRequests ??= {}
}
