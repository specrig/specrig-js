import http from "node:http"
import { expect, test } from "@playwright/test"
import { harness } from "../src/harness.js"

const APP = `http://localhost:${41830 + Number(process.env.TEST_PARALLEL_INDEX ?? 0)}`

const app = http.createServer((request, response) => {
  if (request.url === "/sw.js") {
    response.setHeader("content-type", "text/javascript")
    response.end("self.addEventListener('fetch', () => {})")
    return
  }
  response.setHeader("content-type", "text/html")
  response.end(`<!doctype html><title>shop</title><script>
    navigator.serviceWorker.register("/sw.js").then((registration) => { document.title = registration ? "registered" : "refused" })
  </script>`)
})

const shop = harness({ root: "/", service: "shop", backends: {}, surface: { client: "HttpClient" } }).test

test.use({ baseURL: APP })

test.beforeAll(async () => {
  await new Promise<void>((done) => app.listen(new URL(APP).port, () => done()))
})

test.afterAll(async () => {
  await new Promise((done) => app.close(done))
})

shop("a page cannot register a service worker to serve it past the stand-ins", async ({ page }) => {
  await page.goto("/")

  await expect(page).toHaveTitle("refused")
})
