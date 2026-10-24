import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { expect, test } from "@playwright/test"
import YAML from "yaml"
import { build, encode, type Run } from "../src/flows.js"
import { protocol } from "../src/modes.js"

type Traced = { seq: number; dir: string; kind: string; name: string; step: string; request?: unknown; error?: string }
type Case = { case: string; records: Traced[] }

const fixtures = path.join(protocol, "fixtures", "records")

// A web app's inputs are its `When` steps, which carry no body and are never refused, and what it sends is HTTP.
function unseen(trace: Case[]): string[] {
  const found = new Set<string>()
  for (const r of trace.flatMap((c) => c.records)) {
    if (r.dir === "in" && r.kind !== "ui") {
      found.add(`${r.kind} inputs`)
    }
    if (r.dir === "out" && r.kind !== "http") {
      found.add(`${r.kind} outputs`)
    }
    if (r.error) {
      found.add("refusals")
    }
  }
  return [...found]
}

for (const file of readdirSync(fixtures).filter((name) => name.endsWith(".trace.json"))) {
  test(`${file} comes out as its record, byte for byte`, () => {
    const trace = JSON.parse(readFileSync(path.join(fixtures, file), "utf8")) as Case[]
    const beyond = unseen(trace)
    test.skip(beyond.length > 0, `${file} holds what a web app's writer never sees: ${beyond.join(", ")}`)

    const want = readFileSync(path.join(fixtures, file.replace(/\.trace\.json$/, ".flows.yaml")), "utf8")
    const runs = trace.map(({ case: label, records }) => {
      const at = label.indexOf(": ")
      return { feature: label.slice(0, at), scenario: label.slice(at + 2), records: records.map(({ request, ...r }) => ({ ...r, body: request })) }
    }) as Run[]

    expect(encode(build(YAML.parse(want).service, runs))).toBe(want)
  })
}
