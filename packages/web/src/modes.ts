import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import YAML from "yaml"

export const protocol = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "protocol")

export type Mode = { name: string; opens: string[]; includes?: string[]; offered?: boolean; allows: string; brief: string }
export type Class = { name: string; what: string; patterns?: string[] }
export type Layout = Record<string, string[]>
export type Area = { name: string; paths: string[]; modes?: string[]; grant?: string[] }

const table = (() => {
  const t = YAML.parse(readFileSync(path.join(protocol, "modes.yaml"), "utf8")) as { specrig: string; classes: Class[]; modes: Mode[] }
  if (t.specrig !== "modes/1") {
    throw new Error(`modes.yaml is ${t.specrig}, and this tool reads modes/1`)
  }
  return t
})()

export const modes: readonly Mode[] = table.modes
export const classes: readonly Class[] = table.classes

export function lookupMode(name: string): Mode {
  const mode = modes.find((m) => m.name === name)
  if (!mode) {
    throw new Error(`unknown mode "${name}" (have: ${modes.map((m) => m.name).join(", ")})`)
  }
  return mode
}

export function decidedBy(areas: Area[], area: Area): string[] {
  const alike = (p: string, q: string) => path.posix.normalize(`${p}/`) === path.posix.normalize(`${q}/`)
  return area.paths.filter((p) => !areas.some((o) => o.name < area.name && o.paths.some((q) => alike(p, q))))
}
