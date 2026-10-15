import { LuaEntity } from "factorio:runtime"

/** @noSelf */
declare function require(this: void, module: string): unknown

import { onPathRequestFinished } from "./character/pathing"
import { onEntityChanged } from "./planner/terrain"
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
// The terrain model rescans chunks where entities appear or disappear (SPEC §5.6: incremental, budgeted).
for (const ev of [
  defines.events.on_built_entity,
  defines.events.on_robot_built_entity,
  defines.events.script_raised_built,
  defines.events.script_raised_revive,
  defines.events.on_player_mined_entity,
  defines.events.on_robot_mined_entity,
  defines.events.on_entity_died,
  defines.events.script_raised_destroy,
]) {
  script.on_event(ev, (e) => onEntityChanged((e as { entity?: LuaEntity }).entity))
}
registerRemoteInterface()

if (script.active_mods["factorio-test"]) {
  const init = require("__factorio-test__/init") as (this: void, files: string[], config?: object) => void
  init(["test/engine-capabilities_test", "test/remote_test", "test/controller_test", "test/jobs_test", "test/research_test", "test/bootstrap_test", "test/modules_test", "test/routing_test", "test/factory_test"], { load_luassert: false })
}
