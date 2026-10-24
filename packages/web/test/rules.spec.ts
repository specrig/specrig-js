import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { expect, test } from "@playwright/test"
import YAML from "yaml"
import { areas, rules } from "../src/layout.js"
import { modes, protocol } from "../src/modes.js"

const service = (specrigYaml?: string) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "service-"))
  if (specrigYaml !== undefined) {
    writeFileSync(path.join(dir, "specrig.yaml"), specrigYaml)
  }
  return dir
}

test("specrig.yaml replaces a default area by its name and adds its own", () => {
  const got = areas({
    agents: {
      areas: {
        steps: { paths: ["tests/steps/", "tests/support/"], grant: ["platform"] },
        events: { paths: ["../shared/events/"], modes: ["spec", "platform"] },
      },
    },
  })

  expect(got).toEqual([
    { name: "deps", paths: ["package.json", "package-lock.json"], modes: ["platform"], grant: ["redgreen"] },
    { name: "events", paths: ["../shared/events/"], modes: ["spec", "platform"] },
    { name: "flows", paths: ["tests/flows.yaml"], modes: ["spec", "redgreen", "platform"] },
    { name: "steps", paths: ["tests/steps/", "tests/support/"], grant: ["platform"] },
  ])
})

test("an area naming a mode the table does not have is refused by its name", () => {
  expect(() => areas({ agents: { areas: { events: { paths: ["../shared/events/"], grant: ["review"] } } } })).toThrow(
    /^agents\.areas\.events: unknown mode "review" \(have: spec, redgreen, platform, auto\)$/,
  )
})

test("rules are the modes with the cases filled in, the classes with the layout's patterns, and the areas", () => {
  const got = rules(service("agents:\n  areas:\n    gen:\n      paths: [src/gen/]\n      modes: []\n"))

  expect(got.specrig).toBe("rules/1")
  expect(got.modes.map((m) => m.name)).toEqual(modes.map((m) => m.name))
  expect(got.modes.find((m) => m.name === "spec")?.allows).toBe("`tests/feature/**/*.feature`")
  expect(got.classes).toEqual([
    { name: "humans", patterns: ["CONTRIBUTING.md"] },
    { name: "generated", patterns: ["specrig.md", "tests/surface.yaml"] },
    { name: "platform", patterns: ["harness.config.ts", "tests/internal/", "playwright.config.ts", "specrig.yaml", "AGENTS.md", "CLAUDE.md"] },
    { name: "cases", patterns: ["tests/feature/**/*.feature"] },
    { name: "tests", patterns: ["tests/"] },
    { name: "production", patterns: [] },
  ])
  expect(JSON.parse(JSON.stringify(got)).areas.map((a: { name: string; modes?: string[] }) => [a.name, a.modes ?? null])).toEqual([
    ["deps", ["platform"]],
    ["flows", ["spec", "redgreen", "platform"]],
    ["gen", []],
    ["steps", null],
  ])
})

const markers = path.join(protocol, "fixtures", "markers")

for (const file of readdirSync(markers).filter((name) => name.endsWith(".yaml"))) {
  test(`rules take and refuse the markers of ${file} as the protocol does`, () => {
    const fixture = YAML.parse(readFileSync(path.join(markers, file), "utf8")) as { specrig: string; cases: { name: string; marker: string; error?: string }[] }
    expect(fixture.specrig).toBe("markers-fixtures/1")
    for (const c of fixture.cases) {
      let failed = ""
      try {
        rules(service(c.marker))
      } catch (err) {
        failed = (err as Error).message
      }
      expect.soft(failed, c.name).toContain(c.error ?? "")
      expect.soft(failed === "", `${c.name}: ${failed}`).toBe(c.error === undefined)
    }
  })
}

test("rules for a specrig.yaml the tool does not accept fail, naming what is wrong", () => {
  expect(() => rules(service("agents:\n  areas:\n    gen:\n      modes: [spec]\n"))).toThrow("agents.areas.gen names no paths")
})
