import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { init } from "@specrig/web/init"
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

  init(dir, ["--backend", "api=apiUrl", "--contract", "api=../.docs/api.yaml", "--failure", "api=Error"], preset)

  const config = readFileSync(path.join(dir, "harness.config.ts"), "utf8")
  expect(config).toContain('service: "cabinet"')
  expect(config).toContain('origin: "https://api.cabinet.test"')
  expect(config).toContain('field: "apiUrl"')
  expect(config).toContain('contract: "../.docs/api.yaml"')
  expect(config).toContain('lk: { origin: "https://lk.cabinet.test", field: "lkUrl" }')
  expect(config).toContain('constants: { authCookieDomain: "" }')
  expect(config).not.toContain("build:")
  for (const file of ["playwright.config.ts", "Makefile", "tests/internal/harness.ts", "tests/internal/checks.spec.ts", "tests/internal/boot.spec.ts", "tests/steps/bdd.ts", "AGENTS.md"]) {
    expect(existsSync(path.join(dir, file)), file).toBe(true)
  }
  expect(readFileSync(path.join(dir, "tests/internal/checks.spec.ts"), "utf8")).toContain('from "@specrig/vite/playwright"')
  expect(lstatSync(path.join(dir, "CLAUDE.md")).isSymbolicLink()).toBe(true)

  const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"))
  expect(pkg.scripts).toEqual({ build: "vite build", test: "bddgen && playwright test" })
  expect(Object.keys(pkg.devDependencies)).toEqual(["@playwright/test", "playwright-bdd"])
  const makefile = readFileSync(path.join(dir, "Makefile"), "utf8")
  expect(makefile).toContain("npm install --no-save --install-links --legacy-peer-deps --no-audit --no-fund /specrig/packages/web /specrig/packages/vite")
  expect(makefile).toContain("generate:\n\t$(RUN) '$(INSTALL) && npx specrig surface'")
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

test("init keeps what is there", () => {
  const dir = runtimeApp()
  writeFileSync(path.join(dir, "AGENTS.md"), "ours\n")

  const report = init(dir, ["--backend", "api=apiUrl"], preset)

  expect(readFileSync(path.join(dir, "AGENTS.md"), "utf8")).toBe("ours\n")
  expect(report).toContain("= AGENTS.md — kept")
})

test("init refuses a backend setting the app does not read", () => {
  expect(() => init(runtimeApp(), ["--backend", "api=gatewayUrl"], preset)).toThrow(/no setting gatewayUrl/)
})

test("init stops when nothing points the app at a stand-in", () => {
  expect(() => init(app({}), ["--backend", "api"], preset)).toThrow(/nothing points the app at a stand-in/)
})
