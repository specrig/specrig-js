import { expect, test } from "@playwright/test"
import { type Config, coverage, runtimeValues } from "./config.js"

// The settings the app reads are the ones its own server answers with.
export function runtimeTest(config: Config): void {
  if (!config.runtime) {
    return
  }
  const runtime = config.runtime
  test("the harness config answers every runtime setting", async ({ request }) => {
    const served = await request.get(runtime.path)
    expect(served.ok(), `the app serves no ${runtime.path}`).toBe(true)
    const window: Record<string, object | undefined> = {}
    new Function("window", await served.text())(window)
    const read = window[runtime.global]
    expect(read, `${runtime.path} sets no window.${runtime.global}`).toBeDefined()
    expect(
      coverage(Object.keys(runtimeValues(config)), Object.keys(read!)),
      "settings with no stand-in or constant, and names the app does not read",
    ).toEqual({ missing: [], unknown: [] })
  })
}

// What every app's harness checks of itself before any case.
export function checks(config: Config): void {
  runtimeTest(config)
}
