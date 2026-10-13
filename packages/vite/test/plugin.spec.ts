import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { expect, test } from "@playwright/test"
import { build, type InlineConfig, preview } from "vite"
import { runtimeConfig } from "../src/plugin.js"

test("the plugin serves the settings from .env, and leaves the image a template to fill", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "app-"))
  writeFileSync(path.join(root, "index.html"), "<!doctype html><title>app</title>")
  writeFileSync(path.join(root, ".env"), "API_URL=https://api.example.test\n")
  const config: InlineConfig = {
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [runtimeConfig({ apiUrl: "API_URL", mapsKey: "MAPS_KEY" })],
  }

  await build(config)
  expect(readFileSync(path.join(root, "dist", "config.js.template"), "utf8")).toBe(
    'window.__CONFIG__ = {"apiUrl":"${API_URL}","mapsKey":"${MAPS_KEY}"}\n',
  )

  const server = await preview({ ...config, preview: { host: "127.0.0.1", port: 4181, strictPort: true } })
  try {
    const served = await fetch("http://127.0.0.1:4181/config.js")
    expect(await served.text()).toBe('window.__CONFIG__ = {"apiUrl":"https://api.example.test","mapsKey":""}\n')
  } finally {
    await server.close()
  }
})
