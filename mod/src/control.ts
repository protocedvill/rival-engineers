import { LuaEntity } from "factorio:runtime"

/** @noSelf */
declare function require(this: void, module: string): unknown

import { onPathRequestFinished } from "./character/pathing"
import { onEntityChanged } from "./planner/terrain"
import { invalidateConfig } from "./config"
import { onBufferBuilt } from "./modules/buffers"
import { registerRemoteInterface } from "./remote"
import { registerReview } from "./review/index"
import { initStorage } from "./storage-init"
import { onResearchFinished } from "./strategy/bootstrap"
import { onSectorScanned } from "./strategy/explore"
import { onTick } from "./tick"

script.on_init(() => {
  invalidateConfig()
  initStorage()
  storage.autoSpawnPending = true
})
// Schema migrations must also run on a plain load: Factorio does not fire `on_configuration_changed` when the mod set
// and versions are unchanged, and a resumed snapshot can carry an older tile-key encoding.
script.on_load(() => {
  invalidateConfig()
  initStorage()
})
script.on_configuration_changed(() => {
  invalidateConfig()
  initStorage()
})
script.on_event(defines.events.on_runtime_mod_setting_changed, invalidateConfig)
script.on_event(defines.events.on_script_path_request_finished, onPathRequestFinished)
script.on_event(defines.events.on_tick, onTick)
script.on_event(defines.events.on_research_finished, (e) => onResearchFinished(e.research.force, e.research.name))
// P43 (a): faction radars chart nothing (no players on the force); their sector scans are the faction's exploration.
script.on_event(defines.events.on_sector_scanned, onSectorScanned)
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
  script.on_event(ev, (e) => {
    const entity = (e as { entity?: LuaEntity }).entity
    onEntityChanged(entity)
    // D42: a buffer chest built from its ghost gets its slot limit.
    // M7d.5: construction robots build buffer chests too.
    if (ev === defines.events.script_raised_revive || ev === defines.events.script_raised_built || ev === defines.events.on_built_entity || ev === defines.events.on_robot_built_entity) onBufferBuilt(entity)
  })
}
registerRemoteInterface()
registerReview()

if (script.active_mods["factorio-test"]) {
  const init = require("__factorio-test__/init") as (this: void, files: string[], config?: object) => void
  init(["test/engine-capabilities_test", "test/remote_test", "test/controller_test", "test/jobs_test", "test/research_test", "test/bootstrap_test", "test/bootstrap-sources_test", "test/modules_test", "test/routing_test", "test/review_test", "test/graph-window_test", "test/review-tools_test", "test/factory_test", "test/world_test", "test/conflicts_test", "test/mining-arena_test", "test/merge-route_test", "test/reconciler_test", "test/buffers_test", "test/temp-factory_test", "test/preempt-loop_test"], { load_luassert: false })
}
