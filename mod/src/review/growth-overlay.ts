import { Color, MapPosition } from "factorio:runtime"
import { keyX, keyY, Rect } from "../planner/grid"
import { growthArea, PlacedModule } from "../planner/layout"
import { OverlayContext, registerOverlayLayer } from "./overlay"

// Read this overlay before debugging growth placement: it shows the space the planner reserved, not merely the
// entities Factorio has built. That distinction is where prior growth investigations repeatedly lost time.

function outline(ctx: OverlayContext, rect: Rect, color: Color, width: number): void {
  ctx.add(rendering.draw_rectangle({
    color,
    width,
    filled: false,
    left_top: { x: rect.x, y: rect.y },
    right_bottom: { x: rect.x + rect.w, y: rect.y + rect.h },
    surface: ctx.faction.surface,
    players: [ctx.player],
    time_to_live: ctx.ttl,
  }))
}

function claimRect(module: PlacedModule): Rect | undefined {
  const claim = module.minePlan?.claim
  if (claim === undefined || claim.length === 0) return undefined
  let x1 = keyX(claim[0])
  let x2 = x1
  let y1 = keyY(claim[0])
  let y2 = y1
  for (const key of claim) {
    const x = keyX(key)
    const y = keyY(key)
    x1 = math.min(x1, x)
    x2 = math.max(x2, x)
    y1 = math.min(y1, y)
    y2 = math.max(y2, y)
  }
  return { x: x1, y: y1, w: x2 - x1 + 1, h: y2 - y1 + 1 }
}

function drawGrowth(ctx: OverlayContext): void {
  const factory = storage.factories?.[ctx.faction.name]
  if (factory === undefined) return
  for (const module of factory.layout.modules) {
    const area = module.minePlan !== undefined ? claimRect(module) : growthArea(module)
    if (area === undefined) continue
    outline(ctx, module.rect, { r: 0.25, g: 0.9, b: 0.35, a: 0.8 }, 2)
    outline(ctx, area, module.minePlan !== undefined ? { r: 0.3, g: 0.65, b: 1, a: 0.85 } : { r: 1, g: 0.55, b: 0.1, a: 0.85 }, 3)
    let detail = module.minePlan !== undefined ? `mine claim ${module.minePlan.occupied.length}/${module.minePlan.claim.length}` : "growth reserve"
    const failure = factory.growthDiagnostics?.[module.id]
    if (failure !== undefined) detail += `\nlast failure t${failure.tick}: ${failure.reason}`
    const target: MapPosition = { x: area.x + area.w / 2, y: area.y }
    ctx.add(rendering.draw_text({ text: `${module.id}\n${detail}`, target, surface: ctx.faction.surface, players: [ctx.player], color: { r: 1, g: 0.9, b: 0.5 }, alignment: "center", scale: 1, time_to_live: ctx.ttl }))
  }
}

registerOverlayLayer("growth", "Growth reserves and mine claims", drawGrowth, false)
