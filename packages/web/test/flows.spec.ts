import { expect, test } from "@playwright/test"
import { build, type Doc, encode, reconcile } from "../src/flows.js"

const doc = (inputs: Doc["inputs"], orphaned?: Doc["orphaned"]): Doc => ({
  specrig: "flows/1",
  service: "shop",
  inputs,
  ...(orphaned ? { orphaned } : {}),
})

const input = (message: string, description?: string): Doc["inputs"][number] => ({
  message,
  ...(description ? { description } : {}),
  branches: [{ cases: ["shop.feature: The visitor sees the shop"] }],
})

test("a description whose input is gone is orphaned, and comes back with its input", () => {
  const gone = reconcile(doc([input("ui the visitor opens the shop", "Витрина")]), doc([]))
  expect(gone.orphaned).toEqual([{ anchor: "ui the visitor opens the shop", description: "Витрина" }])

  const back = reconcile(gone, doc([input("ui the visitor opens the shop")]))
  expect(back.inputs[0].description).toBe("Витрина")
  expect(back.orphaned).toBeUndefined()
})

test("the record says first that it is specrig's", () => {
  expect(encode(build("shop", [])).split("\n").slice(2, 4)).toEqual(["specrig: flows/1", "service: shop"])
})
