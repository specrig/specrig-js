import http from "node:http"
import path from "node:path"
import { expect, test } from "@playwright/test"
import { Backend } from "../src/backend.js"
import { harness } from "../src/harness.js"
import { route } from "../src/routes.js"
import { Trace } from "../src/trace.js"

const APP = `http://localhost:${41820 + Number(process.env.TEST_PARALLEL_INDEX ?? 0)}`
const contract = path.join(import.meta.dirname, "fixtures", "shop.yaml")

const pages: Record<string, string> = {
  "/both": `<script>
    Promise.all([
      fetch("https://api.shop.test/items/7").then((r) => r.json()),
      fetch("https://api.shop.test/api/catalog/product", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then((r) => r.json()),
    ]).then(([item, found]) => { document.title = item.id + " " + found.total })
  </script>`,
  "/stray": `<script>fetch("https://api.shop.test/elsewhere").catch(() => {})</script>`,
  "/live": `<ul></ul><script>
    new WebSocket("wss://api.shop.test/live").onmessage = (e) => {
      const item = document.createElement("li")
      item.textContent = e.data
      document.querySelector("ul").append(item)
    }
  </script>`,
}

const app = http.createServer((request, response) => {
  response.setHeader("content-type", "text/html")
  response.end(`<!doctype html><title>shop</title>${pages[request.url ?? ""] ?? ""}`)
})

const shared = (catalog: string[]) => ({
  root: "/",
  service: "shop",
  backends: {
    shop: { origin: "https://api.shop.test", contract },
    catalog: { origin: "https://api.shop.test", routes: catalog },
  },
  surface: { client: "HttpClient" },
})

const shop = harness(shared(["POST /api/catalog/product", "WS /live"])).test

test.use({ baseURL: APP })

test.beforeAll(async () => {
  await new Promise<void>((done) => app.listen(new URL(APP).port, () => done()))
})

test.afterAll(async () => {
  await new Promise((done) => app.close(done))
})

test("a backend that shares its origin and names no routes is refused", () => {
  expect(() => harness(shared([]))).toThrow("catalog shares https://api.shop.test with others and names no routes")
})

test("two backends whose routes could take one request are refused, whichever is the more exact", () => {
  expect(() => harness(shared(["GET /items/search"]))).toThrow("shop's GET /items/{id} and catalog's GET /items/search")
})

test("a backend sharing its origin refuses a reply for a route that is not its own", () => {
  const catalog = new Backend(new Trace(), undefined, { name: "catalog", routes: [route("POST /api/catalog/product")] })

  expect(() => catalog.reply("GET", "/items/7", 200, {})).toThrow("GET /items/7 is not one of catalog's routes")
  expect(() => catalog.hold("GET", "/items/{id}")).toThrow("is not one of catalog's routes")
  expect(() => catalog.reply("POST", "/api/catalog/product", 200, {})).not.toThrow()
})

shop("each request on a shared origin is answered by the backend whose route takes it", async ({ page, edges }) => {
  edges.shop.reply("GET", "/items/{id}", 200, { id: "7" })
  edges.catalog.reply("POST", "/api/catalog/product", 200, { total: 3 })
  edges.trace.act("Action", "the visitor opens the shop")

  await page.goto("/both")

  await expect(page).toHaveTitle("7 3")
  expect(edges.shop.requests("GET", "/items/{id}")).toHaveLength(1)
  expect(edges.catalog.requests("POST", "/api/catalog/product")).toHaveLength(1)
  await edges.trace.settle()
  expect(edges.trace.records.filter((r) => r.dir === "out").map((r) => r.name).sort()).toEqual(["GET /items/{id}", "POST /api/catalog/product"])
})

shop("a request on a shared origin no backend's route takes fails the test", async ({ page }) => {
  shop.fail()

  await page.goto("/stray")
  await expect.poll(() => page.evaluate(() => document.readyState)).toBe("complete")
})

shop("a socket on a shared origin is the backend's whose route names it", async ({ page, edges }) => {
  edges.catalog.socket("/live", { open: () => ["prices"] })

  await page.goto("/live")

  await expect(page.getByRole("listitem")).toHaveText(["prices"])
})
