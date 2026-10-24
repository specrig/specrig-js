import { execFileSync } from "node:child_process"
import { readdirSync } from "node:fs"
import path from "node:path"
import { expect, test } from "@playwright/test"
import { protocol } from "../src/modes.js"

test("the published package carries the protocol data rules and specrig.md read, and not the fixtures", () => {
  const [packed] = JSON.parse(
    execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: path.dirname(protocol), encoding: "utf8" }),
  ) as { files: { path: string }[] }[]
  const files = packed.files.map((f) => f.path)

  expect(files).toEqual(
    expect.arrayContaining(["protocol/modes.yaml", ...readdirSync(path.join(protocol, "agents")).map((part) => `protocol/agents/${part}`)]),
  )
  expect(files.filter((f) => f.startsWith("protocol/fixtures/"))).toEqual([])
})
