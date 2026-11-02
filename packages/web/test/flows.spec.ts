import { mkdtempSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { expect, test } from "@playwright/test"
import { build, caseTitle, type Doc, encode, reconcile } from "../src/flows.js"

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

test("an outline's row is the case of the outline's title filled from the row, whatever titles its test", () => {
  const feature = path.join(mkdtempSync(path.join(os.tmpdir(), "feature-")), "shop.feature")
  writeFileSync(
    feature,
    "Feature: The shop\n\n  Scenario Outline: The visitor buys <item>\n    When the visitor buys <item>\n\n" +
      "    # title-format: buying <item>\n    Examples:\n      | item |\n      | Tea  |\n",
  )
  expect(caseTitle(feature, 9)).toBe("The visitor buys Tea")
})

test("the record says first that it is specrig's", () => {
  expect(encode(build("shop", [])).split("\n").slice(2, 4)).toEqual(["specrig: flows/1", "service: shop"])
})
