import http from "node:http"
import { expect, test } from "@playwright/test"
import { harness } from "../src/harness.js"

const APP = `http://localhost:${41810 + Number(process.env.TEST_PARALLEL_INDEX ?? 0)}`

const pages: Record<string, string> = {
  "/socket": `<ul></ul><script>
    const ws = new WebSocket("wss://api.shop.test/inbox?token=1")
    ws.onopen = () => ws.send(JSON.stringify({ subscribe: "inbox" }))
    ws.onmessage = (e) => {
      const item = document.createElement("li")
      item.textContent = JSON.parse(e.data).event
      document.querySelector("ul").append(item)
    }
  </script>`,
  "/elsewhere": `<script>new WebSocket("wss://elsewhere.example/live")</script>`,
  "/sdk": `<script src="https://cdn.shop.test/sdk.js"></script><script>document.title = window.sdk?.ready ? "ready" : "missing"</script>`,
  "/boot": `<script>fetch("https://api.shop.test/settings").then((r) => r.json()).then((s) => { document.title = s.name })</script>`,
}

const app = http.createServer((request, response) => {
  response.setHeader("content-type", "text/html")
  response.end(`<!doctype html><title>shop</title>${pages[request.url ?? ""] ?? ""}`)
})

const config = {
  root: "/",
  service: "shop",
  backends: { api: { origin: "https://api.shop.test" }, cdn: { origin: "https://cdn.shop.test" } },
  surface: { client: "HttpClient" },
}
const shop = harness(config).test
const booted = harness({ ...config, boot: ({ api }) => api.reply("GET", "/settings", 200, { name: "Corner shop" }) }).test

test.use({ baseURL: APP })

test.beforeAll(async () => {
  await new Promise<void>((done) => app.listen(new URL(APP).port, () => done()))
})

test.afterAll(async () => {
  await new Promise((done) => app.close(done))
})

shop("the backend greets a socket and answers its frames as its conversation says", async ({ page, edges }) => {
  edges.api.socket("/inbox", {
    open: () => [{ event: "hello" }],
    message: (frame) => [{ event: `subscribed to ${(frame as { subscribe: string }).subscribe}` }],
  })

  await page.goto("/socket")

  await expect(page.getByRole("listitem")).toHaveText(["hello", "subscribed to inbox"])
  expect(edges.api.frames("/inbox")).toEqual([{ subscribe: "inbox" }])
})

shop("a frame a step pushes reaches the socket the page has open", async ({ page, edges }) => {
  edges.api.socket("/inbox")

  await page.goto("/socket")
  await edges.api.push("/inbox", { event: "outbid" })

  await expect(page.getByRole("listitem")).toHaveText(["outbid"])
})

shop("pushing where no socket opens fails the step", async ({ edges }) => {
  await expect(edges.api.push("/inbox", { event: "outbid" })).rejects.toThrow("no socket is open on /inbox")
})

shop("a socket the page opens to a backend no step declared it for fails the test", async ({ page }) => {
  shop.fail()

  await page.goto("/socket")
  await expect.poll(() => page.evaluate(() => document.readyState)).toBe("complete")
})

shop("a socket to an origin the config does not name fails the test", async ({ page }) => {
  shop.fail()

  await page.goto("/elsewhere")
  await expect.poll(() => page.evaluate(() => document.readyState)).toBe("complete")
})

shop("a reply that is not JSON is answered as it is, as a script the page runs", async ({ page, edges }) => {
  edges.cdn.reply("GET", "/sdk.js", 200, "window.sdk = { ready: true }", { "content-type": "text/javascript" })

  await page.goto("/sdk")

  await expect(page).toHaveTitle("ready")
})

booted("what the config's boot declares answers the page without a step", async ({ page }) => {
  await page.goto("/boot")

  await expect(page).toHaveTitle("Corner shop")
})
