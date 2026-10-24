import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { agents, init } from "@specrig/web/init"
import { expect, test } from "@playwright/test"
import { envRead } from "../src/env.js"
import { preset } from "../src/preset.js"

function app(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "app-"))
  const all = {
    "package.json": JSON.stringify({ name: "cabinet", scripts: { build: "vite build" } }),
    ".gitignore": "node_modules\ndist",
    ...files,
  }
  for (const [name, body] of Object.entries(all)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    writeFileSync(path.join(dir, name), body)
  }
  return dir
}

const runtimeApp = (config = "vite.config.ts") =>
  app({
    [config]: `export default defineConfig({
  plugins: [
    runtimeConfig({
      apiUrl: "API_URL",
      lkUrl: "LK_URL",
      authCookieDomain: "AUTH_COOKIE_DOMAIN",
    }),
  ],
})
`,
  })

const buildApp = () =>
  app({
    "src/main.ts": `const api = new HttpClient(import.meta.env.VITE_API_URL)
const help = import.meta.env["VITE_HELP_URL"]
if (import.meta.env.DEV) console.log(import.meta.env.MODE)
`,
    "src/shop/title.tsx": "export const Title = () => <h1>{import.meta.env.VITE_SHOP_NAME}</h1>\n",
  })

test("the runtime settings are read from the map handed to runtimeConfig, in whichever Vite config the app has", () => {
  for (const config of ["vite.config.ts", "vite.config.mjs", "vite.config.js"]) {
    expect(preset.settings(runtimeApp(config)).runtime, config).toEqual(["apiUrl", "lkUrl", "authCookieDomain"])
  }
  expect(preset.settings(buildApp()).runtime).toBeUndefined()
})

test("the build's variables are the ones the code reads from import.meta.env, less Vite's own", () => {
  expect(envRead(path.join(buildApp(), "src"))).toEqual(["VITE_API_URL", "VITE_HELP_URL", "VITE_SHOP_NAME"])
})

test("init points a backend at a runtime setting", () => {
  const dir = runtimeApp()

  const report = init(dir, ["--backend", "api=apiUrl", "--contract", "api=../.docs/api.yaml", "--failure", "api=Error"], preset)

  const config = readFileSync(path.join(dir, "harness.config.ts"), "utf8")
  expect(config).toContain('service: "cabinet"')
  expect(config).toContain('origin: "https://api.cabinet.test"')
  expect(config).toContain('field: "apiUrl"')
  expect(config).toContain('contract: "../.docs/api.yaml"')
  expect(config).toContain('lk: { origin: "https://lk.cabinet.test", field: "lkUrl" }')
  expect(config).toContain('constants: { authCookieDomain: "" }')
  expect(config).not.toContain("build:")
  for (const file of ["playwright.config.ts", "specrig.yaml", "tests/internal/harness.ts", "tests/internal/checks.spec.ts", "tests/internal/boot.spec.ts", "tests/steps/bdd.ts", "AGENTS.md", "specrig.md"]) {
    expect(existsSync(path.join(dir, file)), file).toBe(true)
  }
  expect(existsSync(path.join(dir, "Makefile"))).toBe(false)
  expect(readFileSync(path.join(dir, "tests/internal/checks.spec.ts"), "utf8")).toContain('from "@specrig/vite/playwright"')
  expect(lstatSync(path.join(dir, "CLAUDE.md")).isSymbolicLink()).toBe(true)

  const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"))
  expect(pkg.scripts).toEqual({ build: "vite build", test: "bddgen && playwright test" })
  expect(Object.keys(pkg.devDependencies)).toEqual(["@playwright/test", "playwright-bdd"])
  expect(report).toContainEqual(expect.stringMatching(/^ {2}then, before every run: npm install --no-save --install-links \S+\/packages\/web \S+\/packages\/vite$/))
  expect(readFileSync(path.join(dir, ".gitignore"), "utf8")).toBe("node_modules\ndist\n.features-gen\ntest-results\nplaywright-report\nblob-report\n")
})

test("init points a backend at a variable the build reads", () => {
  const dir = buildApp()

  init(dir, ["--backend", "shop=VITE_API_URL"], preset)

  const config = readFileSync(path.join(dir, "harness.config.ts"), "utf8")
  expect(config).toContain('env: "VITE_API_URL"')
  expect(config).toContain('help: { origin: "https://help.cabinet.test", env: "VITE_HELP_URL" }')
  expect(config).toContain('build: { constants: { VITE_SHOP_NAME: "" } }')
  expect(config).not.toContain("runtime:")
})

const reference = "Read @specrig.md before the first edit: Rule #11, and how this app's suite runs."

test("init keeps what is there", () => {
  const dir = runtimeApp()
  writeFileSync(path.join(dir, "AGENTS.md"), `ours\n\n${reference}\n`)
  writeFileSync(path.join(dir, "specrig.yaml"), "guard: [npx, --no, specrig]\nflows:\n  clients:\n    http-client.api: billing\n")

  const report = init(dir, ["--backend", "api=apiUrl"], preset)

  expect(readFileSync(path.join(dir, "AGENTS.md"), "utf8")).toBe(`ours\n\n${reference}\n`)
  expect(report).toContain("= AGENTS.md — kept")
  expect(report).toContain("= specrig.yaml — kept")
})

test("init writes an AGENTS.md of the app's own that brings specrig.md in", () => {
  const dir = runtimeApp()

  const report = init(dir, ["--backend", "api=apiUrl"], preset)

  const stub = readFileSync(path.join(dir, "AGENTS.md"), "utf8")
  expect(stub).toMatch(/^# AGENTS\.md\n\nInstructions for AI coding agents working in cabinet\.\n\n/)
  expect(stub).toContain(`\n${reference}\n`)
  expect(stub).toContain("\n## This app\n")
  expect(stub).not.toContain("Rule #11 — specification before code")
  expect(report).toEqual(expect.arrayContaining(["+ AGENTS.md", "+ specrig.md"]))
})

test("init adds the line that brings specrig.md in to the end of an AGENTS.md that lacks it", () => {
  const dir = runtimeApp()
  writeFileSync(path.join(dir, "AGENTS.md"), "ours")

  const report = init(dir, ["--backend", "api=apiUrl"], preset)

  expect(readFileSync(path.join(dir, "AGENTS.md"), "utf8")).toBe(`ours\n\n${reference}\n`)
  expect(report).toContain("~ AGENTS.md: the line that brings specrig.md in, at its end")
})

test("init says what is left of an AGENTS.md that still carries Rule #11", () => {
  const dir = runtimeApp()
  writeFileSync(path.join(dir, "AGENTS.md"), "# AGENTS.md\n\n## Rule #11 — specification before code\n")

  const report = init(dir, ["--backend", "api=apiUrl"], preset)

  expect(readFileSync(path.join(dir, "AGENTS.md"), "utf8")).toBe(`# AGENTS.md\n\n## Rule #11 — specification before code\n\n${reference}\n`)
  expect(report).toContain(
    "~ AGENTS.md: the line that brings specrig.md in, at its end; it still carries Rule #11, which specrig.md holds now: keep the app's own sections in it and delete the rest",
  )
  expect(() => agents(dir, preset)).toThrow("AGENTS.md still carries Rule #11")
})

test("specrig.md holds nothing init was told, so agents writes it as init did", () => {
  const dir = runtimeApp()

  init(dir, ["--backend", "api=apiUrl", "--contract", "api=../.docs/api.yaml", "--failure", "api=Error"], preset)

  const written = readFileSync(path.join(dir, "specrig.md"), "utf8")
  expect(written).not.toContain("edges.api")
  expect(written).not.toContain("api.yaml")
  expect(written).not.toContain("cabinet")
  expect(agents(dir, preset)).toEqual([])
  expect(readFileSync(path.join(dir, "specrig.md"), "utf8")).toBe(written)
})

test("agents fails while AGENTS.md does not bring specrig.md in, and writes specrig.md all the same", () => {
  const dir = runtimeApp()
  writeFileSync(path.join(dir, "AGENTS.md"), "ours\n")

  expect(() => agents(dir, preset)).toThrow(`AGENTS.md does not bring specrig.md in: add the line\n\n${reference}\n\n`)
  expect(existsSync(path.join(dir, "specrig.md"))).toBe(true)
})

test("agents writes nothing where there is no AGENTS.md", () => {
  const dir = runtimeApp()

  expect(() => agents(dir, preset)).toThrow("there is no AGENTS.md here")
  expect(existsSync(path.join(dir, "specrig.md"))).toBe(false)
})

test("init names the guard in the specrig.yaml it writes", () => {
  const dir = runtimeApp()

  const report = init(dir, ["--backend", "api=apiUrl"], preset)

  expect(readFileSync(path.join(dir, "specrig.yaml"), "utf8")).toBe("guard: [npx, --no, specrig]\n")
  expect(report).toContain("+ specrig.yaml")
})

test("init keeps a specrig.yaml that names no guard, and says to add it", () => {
  const dir = runtimeApp()
  const ours = "flows:\n  clients:\n    http-client.api: billing\n"
  writeFileSync(path.join(dir, "specrig.yaml"), ours)

  const report = init(dir, ["--backend", "api=apiUrl"], preset)

  expect(readFileSync(path.join(dir, "specrig.yaml"), "utf8")).toBe(ours)
  expect(report).toContain("= specrig.yaml — kept, and it names no guard: add `guard: [npx, --no, specrig]` to it for a tool to enforce the modes")
})

test("the specrig.md init writes has every slot filled, and the mode and area tables", () => {
  const dir = runtimeApp()
  writeFileSync(path.join(dir, "specrig.yaml"), "guard: [npx, --no, specrig]\nagents:\n  areas:\n    contracts:\n      paths: [../docs/api/]\n      modes: [spec, platform]\n")

  init(dir, ["--backend", "api=apiUrl"], preset)

  const specrig = readFileSync(path.join(dir, "specrig.md"), "utf8")
  expect(specrig).not.toContain("{{")
  expect(specrig).toMatch(/^# specrig\.md\n\n/)
  expect(specrig).toMatch(/`npx --no specrig agents` writes this file with `@specrig\/web` \d+\.\d+\.\d+/)
  expect(specrig).not.toContain("`make ")
  expect(specrig).toContain(`| mode | may be edited |
|---|---|
| spec | \`tests/feature/**/*.feature\` |
| redgreen | the steps and production code — anything but the cases and the platform's files |
| platform | the platform's files, and production code for a seam |
`)
  expect(specrig).toContain(`| area | paths | open in | granted in |
|---|---|---|---|
| contracts | \`../docs/api/\` | spec, platform | — |
| deps | \`package.json\`, \`package-lock.json\` | platform | redgreen |
| flows | \`tests/flows.yaml\` | spec, redgreen, platform | — |
| steps | \`tests/steps/\` | as the table says | platform |
`)
  expect(specrig).toContain("**An edit the mode does not allow is refused, and a refusal is a stop.**")
  expect(specrig).not.toContain("specrig guard")
  expect(specrig).toContain("edges.<backend>.replyTo(method, path, query, status, body)")
})

test("init refuses a backend setting the app does not read", () => {
  expect(() => init(runtimeApp(), ["--backend", "api=gatewayUrl"], preset)).toThrow(/no setting gatewayUrl/)
})

test("init stops when nothing points the app at a stand-in", () => {
  expect(() => init(app({}), ["--backend", "api"], preset)).toThrow(/nothing points the app at a stand-in/)
})
