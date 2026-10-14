/** @noSelf */
declare function require(this: void, module: string): unknown

import { onPathRequestFinished } from "./character/pathing"
import { registerRemoteInterface } from "./remote"
import { initStorage } from "./storage-init"
import { onResearchFinished } from "./strategy/bootstrap"
import { onTick } from "./tick"

script.on_init(() => {
  initStorage()
  storage.autoSpawnPending = true
})
script.on_configuration_changed(initStorage)
script.on_event(defines.events.on_script_path_request_finished, onPathRequestFinished)
script.on_event(defines.events.on_tick, onTick)
script.on_event(defines.events.on_research_finished, (e) => onResearchFinished(e.research.force, e.research.name))
registerRemoteInterface()

if (script.active_mods["factorio-test"]) {
  const init = require("__factorio-test__/init") as (this: void, files: string[], config?: object) => void
  init(["test/engine-capabilities_test", "test/remote_test", "test/controller_test", "test/jobs_test", "test/research_test", "test/bootstrap_test"], { load_luassert: false })
}
