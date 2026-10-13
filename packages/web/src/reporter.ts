import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { FullConfig, FullResult, Reporter, TestCase, TestResult } from "@playwright/test/reporter"
import { build, encode, read, reconcile, type Run } from "./flows.js"
import { recording } from "./record.js"

// A narrowed run saw part of the app, and its record would lose the rest.
const narrowing = ["--grep", "-g", "--grep-invert", "--project", "--last-failed", "--only-changed", "--shard"]
const valued = ["-c", "--config", "-j", "--workers", "--reporter", "--retries", "--timeout", "--global-timeout", "--output", "--repeat-each", "--max-failures", "--trace", "--tsconfig", "--browser"]

export function narrowed(argv: string[]): boolean {
  const args = argv.slice(argv.indexOf("test") + 1)
  for (let i = 0; i < args.length; i++) {
    if (narrowing.some((n) => args[i] === n || args[i].startsWith(`${n}=`))) {
      return true
    }
    if (valued.includes(args[i])) {
      i++
    } else if (!args[i].startsWith("-")) {
      return true
    }
  }
  return false
}

export default class FlowsReporter implements Reporter {
  private runs: Run[] = []
  private whole = true
  private root = process.cwd()
  private outputDir = ""

  constructor(private readonly options: { service: string }) {}

  onBegin(config: FullConfig): void {
    this.whole = !narrowed(process.argv)
    this.root = config.configFile ? path.dirname(config.configFile) : config.rootDir
    this.outputDir = config.projects[0]?.outputDir ?? path.join(this.root, "test-results")
  }

  onTestEnd(_test: TestCase, result: TestResult): void {
    const trace = result.attachments.find((a) => a.name === "flows-trace")
    if (trace?.body) {
      this.runs.push(JSON.parse(trace.body.toString()) as Run)
    }
  }

  async onEnd(result: FullResult): Promise<{ status: FullResult["status"] } | void> {
    const record = path.join(this.root, "tests", "flows.yaml")
    const merged = reconcile(read(record), build(this.options.service, this.runs))
    const body = encode(merged)
    mkdirSync(this.outputDir, { recursive: true })
    writeFileSync(path.join(this.outputDir, "flows.yaml"), body)

    if (result.status !== "passed" || !this.whole) {
      if (recording()) {
        console.log("tests/flows.yaml is written by a whole green run only; this run left it as it was")
      }
      return
    }
    if (recording()) {
      writeFileSync(record, body)
      return
    }
    const current = existsSync(record) ? readFileSync(record, "utf8") : ""
    if (current !== body) {
      console.error(
        `tests/flows.yaml does not match what the suite traced (see ${path.relative(this.root, path.join(this.outputDir, "flows.yaml"))}); ` +
          "rewrite it with specrig record and review the diff",
      )
      return { status: "failed" }
    }
    if (merged.orphaned) {
      console.error("tests/flows.yaml: some descriptions lost their anchor — see orphaned")
      return { status: "failed" }
    }
  }
}
