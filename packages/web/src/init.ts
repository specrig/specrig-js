import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { agentsVerdict, referencesSpecrigMd } from "./agents.js"
import { areas, readSpecrigYaml } from "./layout.js"
import {
  agentsStub,
  bddTs,
  bootSpec,
  checksSpec,
  harnessConfig,
  harnessTs,
  type Plan,
  playwrightConfig,
  reference,
  specrigMd,
  specrigYaml,
} from "./templates.js"

export type Preset = {
  packageDir: string
  settings(app: string): { runtime?: string[]; build: string[] }
  none: string
  envPrefix: string
  serving: string
}

export const usage = `specrig init --backend <name>[=<setting>] [options]
specrig surface
specrig agents
specrig rules

surface writes tests/surface.yaml from the app's code. agents writes specrig.md,
Rule #11 for this app with the areas specrig.yaml declares, and fails while
AGENTS.md does not bring it in. rules prints the Rule #11 modes, this app's layout
and its areas as JSON, for the plugin that enforces the modes. The areas are the
defaults and those specrig.yaml declares under agents.areas.

init lays the harness out in the app:

  --backend <name>[=<setting>]  a backend the app's HTTP client calls, and the setting
                                that points at it; repeatable
  --contract <name>=<path>      its OpenAPI document, from the app's directory
  --failure <name>=<schema>     the schema of a 5xx it may answer on any route
  --service <name>              the app's name in its records; package.json's by default
  --server <command>            the command that starts the app's server, for an app that
                                renders on one; the harness starts it for every test

A setting is a field of the app's runtime config or a variable its build reads;
with --server, also a variable the server reads, and a backend may name several,
comma-separated.
Every other one ending in Url or URL is a page the app sends its users to; the
rest are constants the harness answers empty. No file that exists is written but
specrig.md, which is the tool's, and an AGENTS.md that lacks the line bringing
specrig.md in, which gets it at its end.`

type Flags = {
  backend: Map<string, string | undefined>
  contract: Map<string, string>
  failure: Map<string, string>
  service?: string
  server?: string
}

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
      case "--server":
        flags.server = value()
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
  if (all.length === 0 && !flags.server) {
    throw new Error(`${preset.none}: nothing points the app at a stand-in`)
  }
  const settingsOf = (setting: string | undefined) => setting?.split(",").filter(Boolean) ?? []
  const claimed = [...flags.backend.values()].flatMap(settingsOf)
  if (!flags.server) {
    for (const [name, setting] of flags.backend) {
      if (settingsOf(setting).length > 1) {
        throw new Error(`${name} names several settings; only an app's server reads more than one, given with --server`)
      }
    }
    for (const setting of claimed) {
      if (!all.includes(setting)) {
        throw new Error(`the app reads no setting ${setting}; it reads ${all.join(", ")}`)
      }
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
  // What neither the runtime config nor the build reads, the app's server reads from its environment.
  const pointAll = (settings: string[]) => {
    const read = settings.find((setting) => all.includes(setting))
    const server = settings.filter((setting) => setting !== read)
    return { ...(read ? point(read) : {}), ...(server.length > 0 ? { serverEnv: server } : {}) }
  }
  const isUrl = (setting: string) => /(Url|URL)$/.test(setting)
  const constant = (setting: string) => !claimed.includes(setting) && !isUrl(setting)
  const installed = path.join(dir, "node_modules", "@playwright", "test", "package.json")
  return {
    service,
    playwright: existsSync(installed) ? readJson(installed).version : readJson(path.join(own, "package.json")).devDependencies["@playwright/test"],
    adapter: readJson(path.join(preset.packageDir, "package.json")).name,
    serving: preset.serving,
    backends: [...flags.backend].map(([name, setting]) => ({
      name,
      origin: `https://${name}.${service}.test`,
      ...pointAll(settingsOf(setting)),
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
    server: flags.server ? { command: flags.server, build: packageJson.scripts?.build ? "npm run build" : undefined } : undefined,
  }
}

const rendersOnServer = (packageJson: Record<string, any>) =>
  Object.values((packageJson.scripts ?? {}) as Record<string, string>).some((script) => /(^|\s)--ssr(\s|=|$)/.test(script))

type Written = "created" | "rewritten" | "current"

export function writeSpecrigMd(dir: string, preset: Preset): Written {
  const body = specrigMd(areas(readSpecrigYaml(dir)), preset.serving, readJson(path.join(own, "package.json")).version)
  const file = path.join(dir, "specrig.md")
  const before = existsSync(file) ? readFileSync(file, "utf8") : undefined
  if (before === body) {
    return "current"
  }
  writeFileSync(file, body)
  return before === undefined ? "created" : "rewritten"
}

export function agents(dir: string, preset: Preset): string[] {
  const file = path.join(dir, "AGENTS.md")
  if (!existsSync(file)) {
    throw new Error("there is no AGENTS.md here: `npx --no specrig init` writes one that brings specrig.md in")
  }
  const written = writeSpecrigMd(dir, preset)
  const all = written === "current" ? "" : "\n\nspecrig.md is written all the same."
  switch (agentsVerdict(readFileSync(file, "utf8"))) {
    case "stale":
      throw new Error(`AGENTS.md still carries Rule #11, which specrig.md holds now: keep the app's own sections in it and delete the rest${all}`)
    case "unreferenced":
      throw new Error(`AGENTS.md does not bring specrig.md in: add the line\n\n${reference()}\n\nwhere an agent reads it before the first edit${all}`)
  }
  return written === "current" ? [] : ["wrote specrig.md"]
}

function agentsMd(dir: string, service: string): string {
  const file = path.join(dir, "AGENTS.md")
  if (!existsSync(file)) {
    writeFileSync(file, agentsStub(service, existsSync(path.join(dir, "..", "AGENTS.md"))))
    return "+ AGENTS.md"
  }
  const text = readFileSync(file, "utf8")
  const left =
    agentsVerdict(text) === "stale" ? "; it still carries Rule #11, which specrig.md holds now: keep the app's own sections in it and delete the rest" : ""
  if (referencesSpecrigMd(text)) {
    return `= AGENTS.md — kept${left}`
  }
  const gap = text === "" ? "" : text.endsWith("\n") ? "\n" : "\n\n"
  writeFileSync(file, `${text}${gap}${reference()}\n`)
  return `~ AGENTS.md: the line that brings specrig.md in, at its end${left}`
}

export function init(dir: string, args: string[], preset: Preset): string[] {
  const packageFile = path.join(dir, "package.json")
  if (!existsSync(packageFile)) {
    throw new Error(`${dir} has no package.json`)
  }
  const packageJson = readJson(packageFile)
  const config = readSpecrigYaml(dir)
  const flags = parse(args)
  const p = plan(dir, flags, packageJson, preset)
  const report: string[] = []

  const files: [string, string][] = [
    ["harness.config.ts", harnessConfig(p)],
    ["playwright.config.ts", playwrightConfig(p)],
    ["specrig.yaml", specrigYaml],
    ["tests/internal/harness.ts", harnessTs],
    ["tests/internal/checks.spec.ts", checksSpec(p)],
    ["tests/internal/boot.spec.ts", bootSpec],
    ["tests/steps/bdd.ts", bddTs],
  ]
  for (const [name, body] of files) {
    const file = path.join(dir, name)
    if (existsSync(file)) {
      report.push(
        name === "specrig.yaml" && !config?.guard
          ? `= ${name} — kept, and it names no guard: add \`${specrigYaml.trim()}\` to it for a tool to enforce the modes`
          : `= ${name} — kept`,
      )
      continue
    }
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, body)
    report.push(`+ ${name}`)
  }
  mkdirSync(path.join(dir, "tests", "feature"), { recursive: true })
  report.push(agentsMd(dir, p.service))
  report.push({ created: "+ specrig.md", rewritten: "~ specrig.md", current: "= specrig.md — current" }[writeSpecrigMd(dir, preset)])
  const claude = path.join(dir, "CLAUDE.md")
  if (!existsSync(claude)) {
    symlinkSync("AGENTS.md", claude)
    report.push("+ CLAUDE.md → AGENTS.md")
  } else if (!lstatSync(claude).isSymbolicLink()) {
    const text = readFileSync(claude, "utf8")
    if (!referencesSpecrigMd(text) && !text.includes("@AGENTS.md")) {
      report.push("! CLAUDE.md is a file of its own, which Claude Code reads instead of AGENTS.md: bring AGENTS.md or specrig.md in from it")
    }
  }

  const wanted: Record<string, string> = {
    "@playwright/test": p.playwright,
    "playwright-bdd": "^9.2.1",
  }
  if (published) {
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
  if (!published) {
    const checkout = [own, preset.packageDir].map((p) => path.relative(dir, p)).join(" ")
    report.push(`  then, before every run: npm install --no-save --install-links ${checkout}`)
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
  if (!flags.server && rendersOnServer(packageJson)) {
    report.push(
      '! the build renders on a server (--ssr): with --server "<the command that starts it>" the harness starts it for every test and stands in for what it sends',
    )
  }
  return report
}
