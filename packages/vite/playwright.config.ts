import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "test",
  testIgnore: "**/app/**",
  forbidOnly: true,
})
