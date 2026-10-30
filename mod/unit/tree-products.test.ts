import { eq, run, test } from "./harness"
import { pickTreeItem } from "../src/strategy/tree-products"

test("tree products: wood wins over an earlier Space Age product", () => {
  eq(pickTreeItem([{ type: "item", name: "spoilage" }, { type: "item", name: "wood" }]), "wood")
  eq(pickTreeItem([{ type: "item", name: "carbon" }, { type: "item", name: "wood" }]), "wood")
})

test("tree products: falls back to the first item and ignores fluids", () => {
  eq(pickTreeItem([{ type: "fluid", name: "water" }, { type: "item", name: "carbon" }]), "carbon")
  eq(pickTreeItem(undefined), undefined)
})

run("tree-products")
