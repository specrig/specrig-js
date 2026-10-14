import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { agents, bddTs, bootSpec, checksSpec, harnessConfig, harnessTs, makefile, type Plan, playwrightConfig } from "./templates.js"

export type Preset = {
  packageDir: string
  settings(app: string): { runtime?: string[]; build: string[] }
  none: string
  envPrefix: string
  serving: string
}

export const usage = `specrig init --backend <name>[=<setting>] [options]
specrig surface

surface writes tests/surface.yaml from the app's code. init lays the harness out
in the app:

  --backend <name>[=<setting>]  a backend the app's HTTP client calls, and the setting
                                that points at it; repeatable
  --contract <name>=<path>      its OpenAPI document, from the app's directory
  --failure <name>=<schema>     the schema of a 5xx it may answer on any route
  --service <name>              the app's name in its records; package.json's by default

A setting is a field of the app's runtime config or a variable its build reads.
Every other one ending in Url or URL is a page the app sends its users to; the
rest are constants the harness answers empty. No file that exists is written.`

type Flags = { backend: Map<string, string | undefined>; contract: Map<string, string>; failure: Map<string, string>; service?: string }

function parse(args: string[]): Flags {
  const flags: Flags = { backend: new Map(), contract: new Map(), failure: new Map() }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const value = () => {
      const v = args[++i]
      if (v === undefined) {
        throw new Error(`${arg} needs a value`)
      }
      return v
    }
    const pair = (into: Map<string, string>) => {
      const [name, v] = value().split("=")
      if (!v) {
        throw new Error(`${arg} wants <name>=<value>`)
      }
      into.set(name, v)
    }
    switch (arg) {
      case "--backend": {
        const [name, setting] = value().split("=")
        flags.backend.set(name, setting)
        break
      }
      case "--contract":
        pair(flags.contract)
        break
      case "--failure":
        pair(flags.failure)
        break
      case "--service":
        flags.service = value()
        break
      default:
        throw new Error(`unknown argument ${arg}\n\n${usage}`)
    }
  }
  return flags
}

const own = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const published = own.split(path.sep).includes("node_modules")

function readJson(file: string): Record<string, any> {
  return JSON.parse(readFileSync(file, "utf8"))
}

function pageName(setting: string, prefix: string): string {
  const bare = (setting.startsWith(prefix) ? setting.slice(prefix.length) : setting).replace(/_?(Url|URL)$/, "")
  return bare === bare.toUpperCase() ? bare.toLowerCase().replace(/_(.)/g, (_, c: string) => c.toUpperCase()) : bare
}

function plan(dir: string, flags: Flags, packageJson: Record<string, any>, preset: Preset): Plan {
  if (flags.backend.size === 0) {
    throw new Error(`name at least one backend\n\n${usage}`)
  }
  const service = flags.service ?? packageJson.name
  if (!service) {
    throw new Error("package.json has no name; give one with --service")
  }
  const found = preset.settings(dir)
  const runtime = found.runtime ?? []
  const all = [...runtime, ...found.build]
  if (all.length === 0) {
    throw new Error(`${preset.none}: nothing points the app at a stand-in`)
  }
  const claimed = [...flags.backend.values()].filter((s): s is string => s !== undefined)
  for (const setting of claimed) {
    if (!all.includes(setting)) {
      throw new Error(`the app reads no setting ${setting}; it reads ${all.join(", ")}`)
    }
  }
  for (const map of [flags.contract, flags.failure]) {
    for (const name of map.keys()) {
      if (!flags.backend.has(name)) {
        throw new Error(`${name} is not a backend; name it with --backend first`)
      }
    }
  }
  const point = (setting: string) => (runtime.includes(setting) ? { field: setting } : { env: setting })
  const isUrl = (setting: string) => /(Url|URL)$/.test(setting)
  const constant = (setting: string) => !claimed.includes(setting) && !isUrl(setting)
  const installed = path.join(dir, "node_modules", "@playwright", "test", "package.json")
  const checkout = path.dirname(path.dirname(own))
  return {
    service,
    playwright: existsSync(installed) ? readJson(installed).version : readJson(path.join(own, "package.json")).devDependencies["@playwright/test"],
    adapter: readJson(path.join(preset.packageDir, "package.json")).name,
    local: published
      ? undefined
      : { checkout: path.relative(dir, checkout), packages: [own, preset.packageDir].map((p) => path.relative(checkout, p)) },
    serving: preset.serving,
    backends: [...flags.backend].map(([name, setting]) => ({
      name,
      origin: `https://${name}.${service}.test`,
      ...(setting ? point(setting) : {}),
      contract: flags.contract.get(name),
      failure: flags.failure.get(name),
    })),
    pages: all
      .filter((setting) => !claimed.includes(setting) && isUrl(setting))
      .map((setting) => {
        const name = pageName(setting, preset.envPrefix)
        return { name, origin: `https://${name}.${service}.test`, ...point(setting) }
      }),
    runtime: found.runtime?.filter(constant),
    build: found.build.filter(constant),
    parentRules: existsSync(path.join(dir, "..", "AGENTS.md")),
  }
}

export function init(dir: string, args: string[], preset: Preset): string[] {
  const packageFile = path.join(dir, "package.json")
  if (!existsSync(packageFile)) {
    throw new Error(`${dir} has no package.json`)
  }
  const packageJson = readJson(packageFile)
  const p = plan(dir, parse(args), packageJson, preset)
  const report: string[] = []

  const files: [string, string][] = [
    ["harness.config.ts", harnessConfig(p)],
    ["playwright.config.ts", playwrightConfig(p)],
    ["Makefile", makefile(p)],
    ["tests/internal/harness.ts", harnessTs],
    ["tests/internal/checks.spec.ts", checksSpec(p)],
    ["tests/internal/boot.spec.ts", bootSpec],
    ["tests/steps/bdd.ts", bddTs],
    ["AGENTS.md", agents(p)],
  ]
  for (const [name, body] of files) {
    const file = path.join(dir, name)
    if (existsSync(file)) {
      report.push(`= ${name} — kept`)
      continue
    }
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, body)
    report.push(`+ ${name}`)
  }
  mkdirSync(path.join(dir, "tests", "feature"), { recursive: true })
  if (!existsSync(path.join(dir, "CLAUDE.md"))) {
    symlinkSync("AGENTS.md", path.join(dir, "CLAUDE.md"))
    report.push("+ CLAUDE.md → AGENTS.md")
  }

  const wanted: Record<string, string> = {
    "@playwright/test": p.playwright,
    "playwright-bdd": "^9.2.1",
  }
  if (!p.local) {
    wanted["@specrig/web"] = `^${readJson(path.join(own, "package.json")).version}`
    wanted[p.adapter] = `^${readJson(path.join(preset.packageDir, "package.json")).version}`
  }
  const dev: Record<string, string> = { ...packageJson.devDependencies }
  const added = Object.keys(wanted).filter((name) => !dev[name])
  for (const name of added) {
    dev[name] = wanted[name]
  }
  const scripts: Record<string, string> = { ...packageJson.scripts }
  const testScript = !scripts.test
  if (testScript) {
    scripts.test = "bddgen && playwright test"
  }
  if (added.length > 0 || testScript) {
    packageJson.scripts = scripts
    packageJson.devDependencies = Object.fromEntries(Object.entries(dev).sort(([a], [b]) => (a < b ? -1 : 1)))
    writeFileSync(packageFile, `${JSON.stringify(packageJson, null, 2)}\n`)
    report.push(`~ package.json: ${[...added, ...(testScript ? ["the test script"] : [])].join(", ")}`)
  }

  const ignoreFile = path.join(dir, ".gitignore")
  const ignored = existsSync(ignoreFile) ? readFileSync(ignoreFile, "utf8") : ""
  const missing = [".features-gen", "test-results", "playwright-report", "blob-report"].filter(
    (line) => !ignored.split("\n").includes(line),
  )
  if (missing.length > 0) {
    writeFileSync(ignoreFile, `${ignored}${ignored === "" || ignored.endsWith("\n") ? "" : "\n"}${missing.join("\n")}\n`)
    report.push(`~ .gitignore: ${missing.join(", ")}`)
  }
  return report
}
