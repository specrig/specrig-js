import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import YAML from "yaml"
import { ticked } from "./agents.js"
import { type Area, classes, type Layout, lookupMode, modes } from "./modes.js"

export const layout = {
  generated: ["tests/surface.yaml"],
  platform: ["harness.config.ts", "tests/internal/", "playwright.config.ts", "specrig.yaml", "AGENTS.md", "CLAUDE.md"],
  cases: ["tests/feature/**/*.feature"],
  tests: ["tests/"],
} satisfies Layout

export const defaultAreas: Area[] = [
  { name: "deps", paths: ["package.json", "package-lock.json"], modes: ["platform"], grant: ["redgreen"] },
  { name: "flows", paths: ["tests/flows.yaml"], modes: ["spec", "redgreen", "platform"] },
  { name: "steps", paths: ["tests/steps/"], grant: ["platform"] },
]

export type SpecrigYaml = { guard?: unknown; agents?: { areas?: Record<string, unknown> } }

export function readSpecrigYaml(dir: string): SpecrigYaml | undefined {
  const file = path.join(dir, "specrig.yaml")
  if (!existsSync(file)) {
    return undefined
  }
  try {
    return (YAML.parse(readFileSync(file, "utf8")) ?? {}) as SpecrigYaml
  } catch (err) {
    throw new Error(`specrig.yaml: ${(err as Error).message}`)
  }
}

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === "string")

const mapping = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

export function areas(config: SpecrigYaml | undefined): Area[] {
  const byName = new Map(defaultAreas.map((a) => [a.name, a]))
  const declared = config?.agents?.areas ?? {}
  if (!mapping(declared)) {
    throw new Error("agents.areas is not a mapping of areas by name")
  }
  for (const [name, value] of Object.entries(declared)) {
    if (!mapping(value)) {
      throw new Error(`agents.areas.${name} is not a mapping of paths, modes and grant`)
    }
    const { paths, modes, grant } = value
    if (paths === undefined || (strings(paths) && paths.length === 0)) {
      throw new Error(`agents.areas.${name} names no paths`)
    }
    if (!strings(paths)) {
      throw new Error(`agents.areas.${name}.paths is not a list of paths`)
    }
    for (const [key, list] of Object.entries({ modes, grant })) {
      if (list !== undefined && !strings(list)) {
        throw new Error(`agents.areas.${name}.${key} is not a list of modes`)
      }
    }
    for (const m of [...(strings(modes) ? modes : []), ...(strings(grant) ? grant : [])]) {
      try {
        lookupMode(m)
      } catch (err) {
        throw new Error(`agents.areas.${name}: ${(err as Error).message}`)
      }
    }
    byName.set(name, { name, paths, ...(strings(modes) ? { modes } : {}), ...(strings(grant) ? { grant } : {}) })
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

export function rules(dir: string) {
  return {
    specrig: "rules/1",
    modes: modes.map((m) => ({ ...m, allows: m.allows.replaceAll("{{cases}}", ticked(layout.cases)) })),
    classes: classes.map((c) => ({ name: c.name, patterns: [...(c.patterns ?? []), ...((layout as Layout)[c.name] ?? [])] })),
    areas: areas(readSpecrigYaml(dir)),
  }
}
