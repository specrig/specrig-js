import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { expect, test } from "@playwright/test"

const cli = path.resolve(import.meta.dirname, "..", "dist", "cli.js")

function specrigIn(cwd: string, ...args: string[]) {
  const { status, stdout, stderr } = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" })
  return { status, stdout, stderr }
}

const app = () => mkdtempSync(path.join(os.tmpdir(), "app-"))
const specrig = (...args: string[]) => specrigIn(app(), ...args)

test("rules prints rules/1 as one line of JSON", () => {
  const { status, stdout, stderr } = specrig("rules")

  expect([status, stderr, stdout.split("\n").length]).toEqual([0, "", 2])
  expect(JSON.parse(stdout)).toMatchObject({ specrig: "rules/1", areas: [{ name: "deps" }, { name: "flows" }, { name: "steps" }] })
})

test("rules fails with an Error line for a specrig.yaml it does not accept", () => {
  const dir = app()
  writeFileSync(path.join(dir, "specrig.yaml"), "agents:\n  areas:\n    events:\n      paths: [../shared/]\n      modes: [review]\n")

  expect(specrigIn(dir, "rules")).toMatchObject({ status: 1, stderr: 'Error: agents.areas.events: unknown mode "review" (have: spec, redgreen, platform, auto)\n' })
})

test("the guard of an older tool is gone, and named as unknown", () => {
  expect(specrig("guard", "redgreen", "src/main.ts")).toMatchObject({ status: 1, stderr: expect.stringMatching(/^Unknown command "guard"\n/) })
})

test("agents writes specrig.md once, and says so only when it did", () => {
  const dir = app()
  writeFileSync(path.join(dir, "AGENTS.md"), "Read @specrig.md before the first edit.\n")

  expect(specrigIn(dir, "agents")).toEqual({ status: 0, stdout: "wrote specrig.md\n", stderr: "" })
  expect(specrigIn(dir, "agents")).toEqual({ status: 0, stdout: "", stderr: "" })
  expect(existsSync(path.join(dir, "specrig.md"))).toBe(true)
})

test("agents fails with an Error line while AGENTS.md does not bring specrig.md in", () => {
  const dir = app()
  writeFileSync(path.join(dir, "AGENTS.md"), "ours\n")

  expect(specrigIn(dir, "agents")).toMatchObject({ status: 1, stderr: expect.stringMatching(/^Error: AGENTS\.md does not bring specrig\.md in/) })
  expect(specrig("agents")).toMatchObject({ status: 1, stderr: expect.stringMatching(/^Error: there is no AGENTS\.md here/) })
})

test("a command the tool does not have is named, and fails", () => {
  expect(specrig("allow", "deps")).toMatchObject({ status: 1, stderr: expect.stringMatching(/^Unknown command "allow"\n/) })
})
