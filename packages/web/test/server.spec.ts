import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { expect } from "@playwright/test"
import type { Config, ServerConfig } from "../src/config.js"
import { harness } from "../src/harness.js"

const root = path.join(import.meta.dirname, "fixtures", "ssr")

function shop(server: Partial<ServerConfig> = {}, origin = "https://api.shop.test", constants: Record<string, string> = {}, boot?: Config["boot"]) {
  return harness({
    root,
    service: "shop",
    build: { constants },
    backends: { api: { origin, serverEnv: "API_URL" } },
    surface: { client: "HttpClient" },
    server: { command: "node server.mjs", ...server },
    boot,
  }).test
}

const tea = [{ name: "Tea" }, { name: "Coffee" }]

const withPreload = shop()

withPreload("the page the app's server renders shows what the stand-in answered its fetch", async ({ page, edges }) => {
  edges.api.reply("GET", "/items", 200, tea)

  await page.goto("/")

  await expect(page.getByRole("listitem")).toHaveText(["Tea", "Coffee"])
})

withPreload("the stand-in answers the server's http.request too", async ({ page, edges }) => {
  edges.api.reply("GET", "/items", 200, tea)

  await page.goto("/http")

  await expect(page.getByRole("listitem")).toHaveText(["Tea", "Coffee"])
})

withPreload("the stand-in answers a client that sends through the proxy its environment names, as axios does", async ({ page, edges }) => {
  edges.api.reply("GET", "/items", 200, tea)

  await page.goto("/proxied")

  await expect(page.getByRole("listitem")).toHaveText(["Tea", "Coffee"])
})

withPreload("what the server sent is what reached the backend", async ({ page, edges }) => {
  edges.api.reply("GET", "/items", 200, tea)

  await page.goto("/")

  expect(edges.api.requests("GET", "/items")).toHaveLength(1)
})

withPreload("a request of the server's to an origin the config does not name fails the test", async ({ page }) => {
  withPreload.fail()

  await page.goto("/elsewhere")
})

withPreload("a call of the server's no step answered fails the test", async ({ page }) => {
  withPreload.fail()

  await page.goto("/")
})

withPreload("a server that ends during the test fails it", async ({ page, baseURL }) => {
  withPreload.fail()

  await page.goto("/crash")

  await expect.poll(() => fetch(`${baseURL}/state`).then(() => "up", () => "down")).toBe("down")
})

withPreload("a request of the server's held by a step waits for its release, and the page with it", async ({ page, edges }) => {
  edges.api.reply("GET", "/items", 200, tea)
  edges.api.hold("GET", "/items")

  const loading = page.goto("/")
  await expect.poll(() => edges.api.requests("GET", "/items").length).toBe(1)
  await edges.api.release("GET", "/items")
  await loading

  await expect(page.getByRole("listitem")).toHaveText(["Tea", "Coffee"])
})

withPreload("a page the server renders settles once the server has its answers", async ({ page, edges }) => {
  edges.api.reply("GET", "/items", 200, tea)
  edges.trace.act("Action", "the visitor opens the shop")

  const start = Date.now()
  await page.goto("/")
  await edges.trace.settle()

  expect(Date.now() - start).toBeLessThan(2000)
  expect(edges.trace.records.filter((r) => r.dir === "out").map((r) => [r.name, r.step])).toEqual([["GET /items", "Action"]])
})

withPreload("a timer of the server's fires when the test's clock runs past it", async ({ page }) => {
  await page.clock.install()
  await page.goto("/arm")

  await page.clock.runFor(10_000)
  await page.goto("/state")

  await expect(page.getByRole("paragraph")).toHaveText("fired")
})

withPreload("a timer of the server's waits while the test's clock does not reach it", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-03-01T10:00:00Z") })
  await page.clock.pauseAt(new Date("2026-03-01T10:00:01Z"))
  await page.goto("/arm")

  await page.clock.runFor(9_999)
  await page.goto("/state")

  await expect(page.getByRole("paragraph")).toHaveText("waiting")
})

withPreload("the time the test fixes is the server's time", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-03-01T10:00:00Z"))

  await page.goto("/today")

  await expect(page.locator("time")).toHaveText("2026-03-01")
})

withPreload("a reply that is not JSON reaches the server as it is", async ({ page, edges }) => {
  edges.api.reply("GET", "/note", 200, "Closed on Sundays", { "content-type": "text/plain" })

  await page.goto("/note")

  await expect(page.getByRole("paragraph")).toHaveText("Closed on Sundays")
})

withPreload("a socket the server opens fails the test", async ({ page }) => {
  withPreload.fail()

  await page.goto("/live")
})

shop({ env: { BOOT: "1" } }, undefined, {}, (backends) => backends.api.reply("GET", "/settings", 200, { name: "Corner shop" }))(
  "what the server asks for as it starts is answered from the config's boot",
  async ({ page }) => {
    await page.goto("/booted")

    await expect(page.getByRole("paragraph")).toHaveText("Corner shop")
  },
)

shop({ preload: false, env: { SSR_PORT: "env" } }, "http://api.shop.test")(
  "a server without the preload is answered through the proxy its environment names",
  async ({ page, edges }) => {
    edges.api.reply("GET", "/items", 200, tea)

    await page.goto("/")

    await expect(page.getByRole("listitem")).toHaveText(["Tea", "Coffee"])
  },
)

// One file for the run, whichever worker builds: the build is done once for all of them.
const builds = path.join(os.tmpdir(), "specrig-test-builds")
mkdirSync(builds, { recursive: true })
const out = path.join(builds, `${process.env.SPECRIG_RUN}.txt`)

shop({ build: "node build.mjs" }, undefined, { BUILD_OUT: out })("the server runs what its build made, built once before it", async ({ page }) => {
  await page.goto("/built")

  await expect(page.getByRole("paragraph")).toHaveText("built")
  expect(readFileSync(out, "utf8")).toBe("built")
})

const sharing = harness({
  root,
  service: "shop",
  backends: {
    api: { origin: "https://api.shop.test", serverEnv: "API_URL", routes: ["GET /items"] },
    notes: { origin: "https://api.shop.test", routes: ["GET /note"] },
  },
  surface: { client: "HttpClient" },
  server: { command: "node server.mjs" },
}).test

sharing("what the server asks of a shared origin is answered by the backend whose route takes it", async ({ page, edges }) => {
  edges.notes.reply("GET", "/note", 200, "Closed on Sundays", { "content-type": "text/plain" })

  await page.goto("/note")

  await expect(page.getByRole("paragraph")).toHaveText("Closed on Sundays")
  expect(edges.api.requests("GET", "/note")).toEqual([])
})

const bun = spawnSync("bun", ["--version"]).status === 0
const onBun = shop({ command: "bun server.mjs" })

onBun.describe(() => {
  onBun.skip(!bun, "Bun is not installed")

  onBun("a server on Bun takes the preload too", async ({ page, edges }) => {
    edges.api.reply("GET", "/items", 200, tea)

    await page.goto("/")
    await expect(page.getByRole("listitem")).toHaveText(["Tea", "Coffee"])
    await page.goto("/http")
    await expect(page.getByRole("listitem")).toHaveText(["Tea", "Coffee"])
  })
})
