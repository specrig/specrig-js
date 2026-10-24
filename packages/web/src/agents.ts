import { readFileSync } from "node:fs"
import path from "node:path"
import { type Area, decidedBy, modes, protocol } from "./modes.js"

const parts = ["header", "contributing", "short", "rule11", "reference"]
const slot = /\{\{([a-z-]+)\}\}/g

const read = (part: string) => readFileSync(path.join(protocol, "agents", `${part}.md`), "utf8")

export function render(part: string, slots: Record<string, string>): string {
  if (!parts.includes(part)) {
    throw new Error(`no part "${part}" (have: ${parts.join(", ")})`)
  }
  const unknown = unknownSlots(slots)
  if (unknown.length > 0) {
    throw new Error(`no part has the slots ${unknown.join(", ")}`)
  }
  const missing = new Set<string>()
  const value = (name: string): string => {
    if (Object.hasOwn(slots, name)) {
      return slots[name]
    }
    missing.add(name)
    return ""
  }
  const lines: string[] = []
  for (const line of read(part).split("\n")) {
    const alone = /^\{\{([a-z-]+)\}\}$/.exec(line)
    if (alone && value(alone[1]) === "") {
      continue
    }
    lines.push(line.replace(slot, (_, name: string) => value(name)))
  }
  if (missing.size > 0) {
    throw new Error(`${part} leaves ${[...missing].sort().join(", ")} unfilled`)
  }
  let text = lines.join("\n")
  while (text.includes("\n\n\n")) {
    text = text.replaceAll("\n\n\n", "\n\n")
  }
  return text
}

export function unknownSlots(slots: Record<string, string>): string[] {
  const known = new Set(parts.flatMap((part) => [...read(part).matchAll(slot)].map((m) => m[1])))
  return Object.keys(slots)
    .filter((name) => !known.has(name))
    .sort()
}

export type AgentsVerdict = "absent" | "stale" | "unreferenced" | "ok"

const heading = "## Rule #11 — specification before code"
const token = "@specrig.md"

export function agentsVerdict(text: string | undefined): AgentsVerdict {
  if (text === undefined) {
    return "absent"
  }
  const { stale, referenced } = scan(text)
  return stale ? "stale" : referenced ? "ok" : "unreferenced"
}

export function referencesSpecrigMd(text: string): boolean {
  return scan(text).referenced
}

function scan(text: string): { stale: boolean; referenced: boolean } {
  let fence: { char: string; length: number } | undefined
  let stale = false
  let referenced = false
  for (const line of text.split("\n")) {
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (opening) {
      const run = opening[1]
      if (!fence) {
        fence = { char: run[0], length: run.length }
      } else if (run[0] === fence.char && run.length >= fence.length) {
        fence = undefined
      }
      continue
    }
    if (fence) {
      continue
    }
    stale ||= line.trimEnd() === heading
    referenced ||= standsAlone(line)
  }
  return { stale, referenced }
}

function standsAlone(line: string): boolean {
  const code = codeSpans(line)
  for (let at = line.indexOf(token); at >= 0; at = line.indexOf(token, at + 1)) {
    const end = at + token.length
    const before = at === 0 || /\s/.test(line[at - 1])
    const after = end === line.length || /\s/.test(line[end])
    if (before && after && !code.some(([from, to]) => at >= from && at < to)) {
      return true
    }
  }
  return false
}

function codeSpans(line: string): [number, number][] {
  const spans: [number, number][] = []
  const runs = [...line.matchAll(/`+/g)].map((m) => ({ at: m.index, length: m[0].length }))
  for (let i = 0; i < runs.length; i++) {
    const close = runs.findIndex((r, j) => j > i && r.length === runs[i].length)
    if (close >= 0) {
      spans.push([runs[i].at, runs[close].at + runs[close].length])
      i = close
    }
  }
  return spans
}

export const ticked = (paths: string[]) => `\`${paths.join("`, `")}\``

export function modeRows(cases: string[]): string {
  return modes.map((m) => `| ${m.name} | ${m.allows.replaceAll("{{cases}}", ticked(cases))} |`).join("\n")
}

export function areaRows(areas: Area[]): string {
  const rows: string[] = []
  for (const a of areas) {
    const paths = decidedBy(areas, a)
    if (paths.length === 0) {
      continue
    }
    const open = a.modes === undefined ? "as the table says" : a.modes.length === 0 ? "no mode" : a.modes.join(", ")
    const granted = a.grant?.length ? a.grant.join(", ") : "—"
    rows.push(`| ${a.name} | ${ticked(paths)} | ${open} | ${granted} |`)
  }
  return rows.join("\n")
}
