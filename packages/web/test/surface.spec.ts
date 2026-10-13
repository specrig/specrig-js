import path from "node:path"
import { expect, test } from "@playwright/test"
import { defineConfig } from "../src/config.js"
import { extract } from "../src/surface.js"

const config = defineConfig({
  root: path.join(import.meta.dirname, "fixtures", "app"),
  service: "shop",
  backends: { shop: { origin: "https://shop.test" } },
  surface: { client: "HttpClient" },
})

test("the requests are what the client is called with, a varying segment as {}", () => {
  expect(extract(config)).toEqual(
    new Map([["http-client.httpClient", ["DELETE /account/logout", "GET /items", "GET /items/{}"]]]),
  )
})

test("a JavaScript app is read through its jsconfig.json, and its client named without the extension", () => {
  expect(extract({ ...config, root: path.join(import.meta.dirname, "fixtures", "jsapp") })).toEqual(
    new Map([["main.api", ["GET /items"]]]),
  )
})

test("an app the compiler cannot read is refused, not recorded empty", () => {
  expect(() => extract({ ...config, root: path.join(import.meta.dirname, "fixtures") })).toThrow(
    /has no tsconfig.app.json or tsconfig.json or jsconfig.json/,
  )
  expect(() => extract({ ...config, surface: { client: "HttpClient", sources: "lib" } })).toThrow(
    /tsconfig.app.json takes in no file under lib\//,
  )
})
