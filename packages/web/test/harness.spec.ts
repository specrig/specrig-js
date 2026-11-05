import http from "node:http"
import { expect, test } from "@playwright/test"
import { harness } from "../src/harness.js"

const APP = "http://localhost:41801"
const CDN = "http://localhost:41802"

const app = http.createServer((_, response) => {
  response.setHeader("content-type", "text/html")
  response.end(`<!doctype html><script src="${CDN}/library.js"></script>`)
})
const cdn = http.createServer((_, response) => {
  response.setHeader("content-type", "text/javascript")
  response.end("window.libraryLoaded = true")
})

const withAsset = (live?: boolean) =>
  harness({
    root: "/",
    service: "shop",
    backends: {},
    assets: { cdn: { origin: CDN, live } },
    surface: { client: "HttpClient" },
  }).test

test.use({ baseURL: APP })

test.beforeAll(async () => {
  await new Promise<void>((done) => app.listen(new URL(APP).port, () => done()))
  await new Promise<void>((done) => cdn.listen(new URL(CDN).port, () => done()))
})

test.afterAll(async () => {
  await new Promise((done) => app.close(done))
  await new Promise((done) => cdn.close(done))
})

withAsset(true)("a live asset is answered by its origin", async ({ page }) => {
  await page.goto(APP)
  expect(await page.evaluate(() => "libraryLoaded" in window)).toBe(true)
})

withAsset()("an asset that is not live is answered empty", async ({ page }) => {
  await page.goto(APP)
  expect(await page.evaluate(() => "libraryLoaded" in window)).toBe(false)
})
