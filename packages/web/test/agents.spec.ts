import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { expect, test } from "@playwright/test"
import YAML from "yaml"
import { agentsVerdict, areaRows, modeRows, render } from "../src/agents.js"
import { modes, protocol } from "../src/modes.js"

const filled = (): Record<string, string> => ({
  what: "app",
  writer: "`npx --no specrig agents`",
  version: "`@specrig/web` 0.3.0",
  cut: "`harness.config.ts`",
  validate: "`make test`",
  boundary: "What `harness.config.ts` stands in for is the platform's.",
  "spec-paths": "`tests/feature/`",
  "platform-paths": "`tests/internal/`",
  tasks: "",
  modes: modeRows(["tests/feature/**/*.feature"]),
  "platform-files": "`tests/internal/`",
  generated: "",
  tool: "specrig",
  config: "`specrig.yaml`",
  areas: "| flows | `tests/flows.yaml` | spec, redgreen, platform | — |",
  cases: "`.feature` files in `tests/feature/`",
  contracts: "",
  describes: "",
  binding: "Bind at the page.",
})

test("every part renders with every slot filled", () => {
  for (const part of ["header", "contributing", "short", "rule11", "reference"]) {
    const text = render(part, filled())
    expect(text, part).not.toContain("{{")
    expect(text, part).not.toContain("\n\n\n")
  }
})

test("a slot left out is named", () => {
  const slots = filled()
  delete slots.binding
  delete slots.tasks

  expect(() => render("rule11", slots)).toThrow("rule11 leaves binding, tasks unfilled")
})

test("a slot no part has is named", () => {
  expect(() => render("rule11", { ...filled(), harness: "x" })).toThrow("no part has the slots harness")
})

test("an empty slot alone on its line takes the line, and the blank line it leaves doubled becomes one", () => {
  const text = render("rule11", filled())

  expect(text).toContain("None of the cycle below |\n| a **spike**")
  expect(text).toContain("not yours.\n\n### Writing the cases")
})

test("a slot inside a line is replaced by the stack's text as it is", () => {
  expect(render("short", { ...filled(), validate: "`make test` — $& stays" })).toContain("**After every edit,** `make test` — $& stays.")
})

const fixtures = path.join(protocol, "fixtures", "agents")

for (const file of readdirSync(fixtures).filter((name) => name.endsWith(".yaml"))) {
  test(`AGENTS.md is judged as the protocol's ${file} judges it`, () => {
    const fixture = YAML.parse(readFileSync(path.join(fixtures, file), "utf8")) as {
      specrig: string
      cases: { name: string; agents: string | null; verdict: string }[]
    }
    expect(fixture.specrig).toBe("agents-fixtures/1")
    for (const c of fixture.cases) {
      expect.soft(agentsVerdict(c.agents ?? undefined), c.name).toBe(c.verdict)
    }
  })
}

test("the mode table names the cases", () => {
  const rows = modeRows(["tests/feature/**/*.feature"])

  expect(rows).toContain("| spec | `tests/feature/**/*.feature` |")
  expect(rows.split("\n")).toHaveLength(modes.length)
})

test("the area table says how each area opens", () => {
  const areas = [
    { name: "deps", paths: ["package.json"], modes: ["platform"], grant: ["redgreen"] },
    { name: "steps", paths: ["tests/steps/"], grant: ["platform"] },
    { name: "dist", paths: ["dist/"], modes: [] },
  ]

  expect(areaRows(areas)).toBe(
    "| deps | `package.json` | platform | redgreen |\n| steps | `tests/steps/` | as the table says | platform |\n| dist | `dist/` | no mode | — |",
  )
})

test("an area another names alike and decides is left out of the table", () => {
  const areas = [
    { name: "contracts", paths: ["api/"], modes: ["spec"] },
    { name: "api", paths: ["./api"], modes: ["platform"] },
  ]

  expect(areaRows(areas)).toBe("| api | `./api` | platform | — |")
})
