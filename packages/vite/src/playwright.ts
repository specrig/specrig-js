import { buildEnv, checks as harnessChecks, type Config, coverage, resolve } from "@specrig/web"
import { expect, test } from "@playwright/test"
import { envRead } from "./env.js"

export function envTest(config: Config): void {
  test("the harness config answers every variable the build reads", () => {
    const read = envRead(resolve(config, config.surface.sources ?? "src"))
    expect(
      coverage(Object.keys(buildEnv(config)), read),
      "variables with no stand-in or constant, and names the app does not read",
    ).toEqual({ missing: [], unknown: [] })
  })
}

export function checks(config: Config): void {
  harnessChecks(config)
  envTest(config)
}

const port = 4173

// Vite gives a variable already in the environment precedence over .env, so the stand-ins win.
export function webServer(config: Config) {
  return {
    command: `npm run build && npx vite preview --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    env: buildEnv(config),
    reuseExistingServer: true,
    timeout: 180_000,
  }
}
