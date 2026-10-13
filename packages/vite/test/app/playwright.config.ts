import { webServer } from "@specrig/vite/playwright"
import { defineConfig, devices } from "@playwright/test"
import { defineBddConfig } from "playwright-bdd"
import harness from "./harness.config"

const features = defineBddConfig({
  features: "tests/feature/**/*.feature",
  steps: ["tests/internal/harness.ts", "tests/steps/**/*.ts"],
  missingSteps: "fail-on-gen",
})
const server = webServer(harness)

export default defineConfig({
  forbidOnly: true,
  reporter: [["list"], ["@specrig/web/reporter", { service: "shop" }]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: server.url,
  },
  projects: [
    { name: "harness", testDir: "tests/internal", testMatch: "*.spec.ts" },
    { name: "feature", testDir: features, dependencies: ["harness"] },
  ],
  webServer: server,
})
