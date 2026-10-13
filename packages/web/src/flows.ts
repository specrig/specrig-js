import { existsSync, readFileSync } from "node:fs"
import YAML from "yaml"

export type Traced = {
  seq: number
  dir: "in" | "out"
  kind: "ui" | "http"
  name: string
  body?: unknown
  step: string
}

export type Run = { feature: string; scenario: string; records: Traced[] }

type Branch = { sends?: string[]; sent?: Record<string, string[]>; refused?: string; description?: string; cases: string[] }
type Input = { message: string; description?: string; fields?: string[]; branches: Branch[] }
type Output = { message: string; fields?: string[] }
type Orphan = { anchor: string; description: string }
export type Doc = { service: string; inputs: Input[]; outputs?: Output[]; orphaned?: Orphan[] }

const header =
  "# Generated from the component suite by specrig. The structure is rewritten by\n" +
  "# a whole green run of specrig record; only the description fields are yours.\n"

const byBytes = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

function leafPaths(body: unknown, into: Set<string>, prefix = ""): void {
  if (body === null || body === undefined) {
    return
  }
  if (Array.isArray(body)) {
    body.forEach((child) => leafPaths(child, into, `${prefix}[]`))
  } else if (typeof body === "object") {
    for (const [k, child] of Object.entries(body)) {
      leafPaths(child, into, prefix ? `${prefix}.${k}` : k)
    }
  } else if (prefix) {
    into.add(prefix)
  }
}

// A block sent again straight after itself is one pass of a loop.
function passes(sends: string[]): string[] {
  const out = [...sends]
  for (let folded = true; folded; ) {
    folded = false
    for (let size = 1; size <= out.length / 2 && !folded; size++) {
      for (let i = 0; i + 2 * size <= out.length; i++) {
        if (out.slice(i, i + size).join("\n") === out.slice(i + size, i + 2 * size).join("\n")) {
          out.splice(i + size, size)
          folded = true
          break
        }
      }
    }
  }
  return out
}

const anchorOf = (input: Input, b: Branch) =>
  `${input.message} -> ${(b.sends ?? []).join(", ")}${b.refused ? ` (refused ${b.refused})` : ""}`

export function build(service: string, runs: Run[]): Doc {
  const inputs = new Map<string, Input>()
  const branches = new Map<string, Map<string, Branch>>()
  const outputs = new Map<string, Set<string>>()
  const carriedBy = new Map<Branch, Map<string, Set<string>>>()

  for (const run of [...runs].sort((a, b) => byBytes(`${a.feature}\n${a.scenario}`, `${b.feature}\n${b.scenario}`))) {
    const label = `${run.feature}: ${run.scenario}`
    const records = [...run.records].sort((a, b) => a.seq - b.seq)
    const acting = (r: Traced) => r.step === "Action"
    const sent = new Map<number, string[]>()
    const carried = new Map<number, Map<string, Set<string>>>()
    let last = -1
    records.forEach((r, i) => {
      const message = `${r.kind} ${r.name}`
      if (r.dir === "in" && acting(r)) {
        last = i
        sent.set(i, [])
        carried.set(i, new Map())
        if (!inputs.has(message)) {
          inputs.set(message, { message, branches: [] })
          branches.set(message, new Map())
        }
      } else if (r.dir === "out") {
        const fields = outputs.get(message) ?? new Set<string>()
        leafPaths(r.body, fields)
        outputs.set(message, fields)
        if (last >= 0 && acting(r)) {
          sent.get(last)!.push(message)
          const of = carried.get(last)!
          leafPaths(r.body, of.get(message) ?? of.set(message, new Set()).get(message)!)
        }
      }
    })
    for (const [i, sends] of sent) {
      const message = `${records[i].kind} ${records[i].name}`
      const key = passes(sends).join("\n")
      const branch = branches.get(message)!.get(key) ?? { ...(key ? { sends: key.split("\n") } : {}), cases: [] }
      branches.get(message)!.set(key, branch)
      if (!branch.cases.includes(label)) {
        branch.cases.push(label)
      }
      const into = carriedBy.get(branch) ?? carriedBy.set(branch, new Map()).get(branch)!
      for (const [m, fields] of carried.get(i)!) {
        const all = into.get(m) ?? into.set(m, new Set()).get(m)!
        fields.forEach((f) => all.add(f))
      }
    }
  }
  const withSent = (b: Branch): Branch => {
    const sent = [...(carriedBy.get(b) ?? [])].filter(([, fields]) => fields.size > 0).sort(([x], [y]) => byBytes(x, y))
    if (sent.length === 0) {
      return b
    }
    const { sends, cases } = b
    return { ...(sends ? { sends } : {}), sent: Object.fromEntries(sent.map(([m, f]) => [m, [...f].sort(byBytes)])), cases }
  }

  const doc: Doc = { service, inputs: [] }
  for (const message of [...inputs.keys()].sort(byBytes)) {
    const input = inputs.get(message)!
    input.branches.push(...[...branches.get(message)!.values()].map(withSent))
    input.branches.forEach((b) => b.cases.sort(byBytes))
    input.branches.sort((a, b) => byBytes(anchorOf(input, a), anchorOf(input, b)))
    doc.inputs.push(input)
  }
  const outgoing = [...outputs.keys()].sort(byBytes)
  if (outgoing.length > 0) {
    doc.outputs = outgoing.map((message) => {
      const fields = [...outputs.get(message)!].sort(byBytes)
      return fields.length > 0 ? { message, fields } : { message }
    })
  }
  return doc
}

// Carries the prose of old onto fresh by anchor; what finds no anchor is orphaned.
export function reconcile(old: Doc | undefined, fresh: Doc): Doc {
  const prose = new Map<string, string>()
  for (const input of old?.inputs ?? []) {
    if (input.description) {
      prose.set(input.message, input.description)
    }
    for (const b of input.branches) {
      if (b.description) {
        prose.set(anchorOf(input, b), b.description)
      }
    }
  }
  const used = new Set<string>()
  const inputs = fresh.inputs.map((input) => {
    const description = prose.get(input.message)
    if (description) {
      used.add(input.message)
    }
    const branches = input.branches.map((b) => {
      const d = prose.get(anchorOf(input, b))
      if (d) {
        used.add(anchorOf(input, b))
      }
      return d ? { sends: b.sends, sent: b.sent, refused: b.refused, description: d, cases: b.cases } : b
    })
    return { message: input.message, ...(description ? { description } : {}), fields: input.fields, branches }
  })
  const orphaned = [
    ...(old?.orphaned ?? []),
    ...[...prose.keys()].filter((a) => !used.has(a)).sort(byBytes).map((anchor) => ({ anchor, description: prose.get(anchor)! })),
  ]
  return { ...fresh, inputs, ...(orphaned.length > 0 ? { orphaned } : {}) }
}

export function read(file: string): Doc | undefined {
  return existsSync(file) ? (YAML.parse(readFileSync(file, "utf8")) as Doc) : undefined
}

export function encode(doc: Doc): string {
  return header + YAML.stringify(doc, { indent: 2, lineWidth: 0 })
}
