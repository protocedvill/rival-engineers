// Choosing what a tree yields. Vanilla trees yield wood, but Space Age adds trees whose first product is carbon or
// spoilage (boompuff yields spoilage first and wood second). The bootstrap needs wood for poles and chests, so prefer
// a product named `wood` over the prototype's first product.

export interface MineableProduct {
  type: string
  name?: string
}

/** The item a tree yields for the bootstrap: `wood` when any tree offers it, else the first item product. */
export function pickTreeItem(products: readonly MineableProduct[] | undefined): string | undefined {
  let fallback: string | undefined
  for (const p of products ?? []) {
    if (p.type !== "item" || p.name === undefined) continue
    if (p.name === "wood") return "wood"
    if (fallback === undefined) fallback = p.name
  }
  return fallback
}
