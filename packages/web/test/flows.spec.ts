import { mkdtempSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { expect, test } from "@playwright/test"
import { build, caseTitle, type Doc, encode, reconcile, type Run } from "../src/flows.js"

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

// The visitor opens the shop, and it asks for what each request names, in the round it was answered in.
const opening = (scenario: string, sends: [string, number][]): Run => ({
  feature: "shop.feature",
  scenario,
  records: [
    { seq: 0, dir: "in", kind: "ui", name: "the visitor opens the shop", step: "Action" },
    ...sends.map(([name, round], i) => ({ seq: i + 1, dir: "out" as const, kind: "http" as const, name, step: "Action", round })),
  ],
})

test("the requests of one round are one branch, whichever went first", () => {
  const doc = build("shop", [
    opening("Prices answer first", [["GET /prices", 0], ["GET /stock", 0], ["GET /cart", 1]]),
    opening("Stock answers first", [["GET /stock", 0], ["GET /prices", 0], ["GET /cart", 1]]),
  ])

  expect(doc.inputs[0].branches).toEqual([
    {
      sends: ["http GET /prices", "http GET /stock", "http GET /cart"],
      cases: ["shop.feature: Prices answer first", "shop.feature: Stock answers first"],
    },
  ])
})

test("a request of a later round keeps its place", () => {
  const doc = build("shop", [opening("The cart is saved and read again", [["PUT /cart", 0], ["GET /cart", 1]])])

  expect(doc.inputs[0].branches.map((b) => b.sends)).toEqual([["http PUT /cart", "http GET /cart"]])
})
