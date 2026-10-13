import { mkdtempSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { expect, test } from "@playwright/test"
import { record } from "../src/record.js"

function app(script: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "app-"))
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "app", scripts: { test: script } }))
  return dir
}

test("record runs the app's tests with recording on, and fails when they fail", () => {
  expect(record(app(`node -e "process.exit(process.env.SPECRIG_RECORD ? 0 : 3)"`))).toBe(0)
  expect(record(app(`node -e "process.exit(4)"`))).not.toBe(0)
})
