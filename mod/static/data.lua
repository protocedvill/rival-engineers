-- Data stage: the review tools' hotkeys and shortcut-bar buttons (mod/src/review/: inspector.ts, graph-window.ts,
-- report.ts). B35: custom inputs default to `enabled_while_spectating = false`, so in the sandbox (players are
-- spectators) the hotkeys never fired. Every review input sets it. The shortcut bar is not shown to a spectator:
-- the review toolbar (mod/src/review/toolbar.ts, top-left) has the same buttons.

local function review_input(name, keys, order)
  return {
    type = "custom-input",
    name = name,
    key_sequence = keys,
    action = "lua",
    consuming = "none",
    enabled_while_spectating = true,
    order = order,
  }
end

local function review_shortcut(name, order, icon, toggleable)
  return {
    type = "shortcut",
    name = name,
    order = order,
    action = "lua",
    toggleable = toggleable,
    associated_control_input = name,
    icon = icon,
    icon_size = 32,
    small_icon = icon,
    small_icon_size = 32,
  }
end

data:extend({
  review_input("rival-engineers-toggle-inspector", "CONTROL + SHIFT + I", "a"),
  review_shortcut("rival-engineers-toggle-inspector", "z[rival-engineers]-a", "__core__/graphics/icons/search.png", true),
  review_input("rival-engineers-toggle-graph", "CONTROL + SHIFT + G", "b"),
  review_shortcut("rival-engineers-toggle-graph", "z[rival-engineers]-b", "__core__/graphics/icons/search.png", true),
  review_input("rival-engineers-report", "CONTROL + SHIFT + R", "c"),
  review_shortcut("rival-engineers-report", "z[rival-engineers]-c", "__core__/graphics/icons/tip.png", false),
})

-- Debug/soak only: after the v1 research goal, this hidden infinite technology gives the labs a repeatable pack sink
-- for sustained-throughput tests. It is selected only when `debug-infinite-research` is enabled, and never counts
-- toward the v1 research goal.
data:extend({
  {
    type = "technology",
    name = "rival-engineers-throughput-test",
    icon = "__base__/graphics/technology/automation-science-pack.png",
    icon_size = 256,
    hidden = true,
    max_level = "infinite",
    unit = {
      count_formula = "30",
      ingredients = {
        {"automation-science-pack", 1},
        {"logistic-science-pack", 1},
      },
      time = 60,
    },
    effects = {},
  },
})
