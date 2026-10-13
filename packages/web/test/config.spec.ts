import { expect, test } from "@playwright/test"
import { buildEnv, coverage, defineConfig, runtimeValues } from "../src/config.js"

const config = defineConfig({
  root: "/",
  service: "shop",
  runtime: { path: "/config.js", global: "__CONFIG__", constants: { mapsKey: "" } },
  build: { constants: { VITE_SHOP_NAME: "Corner shop" } },
  backends: {
    api: { origin: "https://api.shop.test", field: "apiUrl" },
    stock: { origin: "https://stock.shop.test", env: "VITE_STOCK_URL" },
  },
  pages: { help: { origin: "https://help.shop.test", env: "VITE_HELP_URL" } },
  surface: { client: "HttpClient" },
})

test("the runtime config holds the fields that point at a stand-in, and the constants", () => {
  expect(runtimeValues(config)).toEqual({ apiUrl: "https://api.shop.test", mapsKey: "" })
})

test("the build is given the variables that point at a stand-in, and the constants", () => {
  expect(buildEnv(config)).toEqual({
    VITE_STOCK_URL: "https://stock.shop.test",
    VITE_HELP_URL: "https://help.shop.test",
    VITE_SHOP_NAME: "Corner shop",
  })
})

test("a setting with no answer, and an answer the app does not read, are both named", () => {
  expect(coverage(["apiUrl", "mapsKey"], ["apiUrl", "lkUrl"])).toEqual({ missing: ["lkUrl"], unknown: ["mapsKey"] })
})
