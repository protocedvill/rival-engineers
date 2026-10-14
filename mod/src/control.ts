/** @noSelf */
declare function require(this: void, module: string): unknown

import { onControllerTick } from "./character/controller"
import { onPathRequestFinished } from "./character/pathing"
import { registerRemoteInterface } from "./remote"
import { initStorage } from "./storage-init"

script.on_init(initStorage)
script.on_configuration_changed(initStorage)
script.on_event(defines.events.on_script_path_request_finished, onPathRequestFinished)
script.on_event(defines.events.on_tick, onControllerTick)
registerRemoteInterface()

if (script.active_mods["factorio-test"]) {
  const init = require("__factorio-test__/init") as (this: void, files: string[], config?: object) => void
  init(["test/engine-capabilities_test", "test/remote_test", "test/controller_test"], { load_luassert: false })
}
