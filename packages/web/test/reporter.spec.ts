import { expect, test } from "@playwright/test"
import { narrowed } from "../src/reporter.js"

const run = (...args: string[]) => narrowed(["node", "playwright", "test", ...args])

test("a run is narrowed by a filter or a file, not by an option's value", () => {
  expect(run()).toBe(false)
  expect(run("-c", "app/playwright.config.ts", "--workers", "2")).toBe(false)
  expect(run("--config=app/playwright.config.ts")).toBe(false)
  expect(run("tests/feature/pay.feature")).toBe(true)
  expect(run("--grep", "pays")).toBe(true)
  expect(run("--project=feature")).toBe(true)
})
