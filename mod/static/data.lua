-- Data stage: the live inspector's hotkey and shortcut-bar button (mod/src/review/inspector.ts).
data:extend({
  {
    type = "custom-input",
    name = "rival-engineers-toggle-inspector",
    key_sequence = "CONTROL + SHIFT + I",
    action = "lua",
    consuming = "none",
    order = "a",
  },
  {
    type = "shortcut",
    name = "rival-engineers-toggle-inspector",
    order = "z[rival-engineers]",
    action = "lua",
    toggleable = true,
    associated_control_input = "rival-engineers-toggle-inspector",
    icon = "__core__/graphics/icons/search.png",
    icon_size = 32,
    small_icon = "__core__/graphics/icons/search.png",
    small_icon_size = 32,
  },
})
