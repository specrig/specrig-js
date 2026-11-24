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
}

const app = http.createServer((request, response) => {
  response.setHeader("content-type", "text/html")
  response.end(`<!doctype html><title>shop</title>${pages[request.url ?? ""] ?? ""}`)
})

const config = {
  root: "/",
  service: "shop",
  backends: { api: { origin: "https://api.shop.test" } },
  surface: { client: "HttpClient" },
}
const shop = harness(config).test

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
