import { Settings } from "./shared/setting-names"

data.extend([
  {
    type: "int-setting",
    name: Settings.factionCount,
    setting_type: "runtime-global",
    default_value: 2,
    minimum_value: 0,
    maximum_value: 16,
    order: "a",
  },
  {
    type: "int-setting",
    name: Settings.crewSize,
    setting_type: "runtime-global",
    default_value: 2,
    minimum_value: 1,
    maximum_value: 8,
    order: "b",
  },
  {
    type: "bool-setting",
    name: Settings.debugTeleportWhenStuck,
    setting_type: "runtime-global",
    default_value: false,
    order: "z-a",
  },
  {
    type: "bool-setting",
    name: Settings.debugInstantCraft,
    setting_type: "runtime-global",
    default_value: false,
    order: "z-b",
  },
])
