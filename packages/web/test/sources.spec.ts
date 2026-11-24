import http from "node:http"
import { type BrowserContext, expect, type Page, test } from "@playwright/test"
import { decode, packageOf, sourceAt } from "../src/sources.js"
import { Trace } from "../src/trace.js"

test("a place maps to the source of the last segment that starts at or before it", () => {
  const decoded = decode({
    sources: ["../node_modules/vuetify/lib/ripple.js", "src/app.ts"],
    mappings: "AAAA,ICAA;ADAA",
  })

  expect(sourceAt(decoded, 1, 1)).toBe("../node_modules/vuetify/lib/ripple.js")
  expect(sourceAt(decoded, 1, 4)).toBe("../node_modules/vuetify/lib/ripple.js")
  expect(sourceAt(decoded, 1, 5)).toBe("src/app.ts")
  expect(sourceAt(decoded, 2, 1)).toBe("../node_modules/vuetify/lib/ripple.js")
  expect(sourceAt(decoded, 3, 1)).toBeUndefined()
})

test("a source in node_modules belongs to its package, a scoped one included", () => {
  expect(packageOf("../node_modules/.pnpm/vue-lazyload@1.3.5/node_modules/vue-lazyload/vue-lazyload.esm.js")).toBe("vue-lazyload")
  expect(packageOf("../../node_modules/@sentry/vue/build/esm/index.js")).toBe("@sentry/vue")
  expect(packageOf("src/app.ts")).toBeUndefined()
})

const APP = `http://localhost:${41840 + Number(process.env.TEST_PARALLEL_INDEX ?? 0)}`

// Each script arms a timer of 900 ms when the button is clicked; its map says where it comes from.
const scripts: Record<string, string> = {
  "/lib.js": "node_modules/slowlib/index.js",
  "/app.js": "src/app.ts",
}

const app = http.createServer((request, response) => {
  const map = request.url?.endsWith(".map") ? request.url.slice(0, -4) : undefined
  if (map && scripts[map]) {
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ version: 3, sources: [scripts[map]], names: [], mappings: "AAAA" }))
  } else if (request.url && scripts[request.url]) {
    response.setHeader("content-type", "text/javascript")
    response.end(`window.arm${request.url === "/lib.js" ? "Lib" : "App"} = () => setTimeout(() => {}, 900)\n//# sourceMappingURL=${request.url}.map`)
  } else {
    response.setHeader("content-type", "text/html")
    response.end(`<!doctype html><script src="/lib.js"></script><script src="/app.js"></script>
      <button id="lib" onclick="armLib()">Lib</button><button id="app" onclick="armApp()">App</button>`)
  }
})

test.beforeAll(async () => {
  await new Promise<void>((done) => app.listen(new URL(APP).port, () => done()))
})

test.afterAll(async () => {
  await new Promise((done) => app.close(done))
})

async function settleAfterClick(context: BrowserContext, page: Page, ignore: string[], button: string): Promise<number> {
  const trace = new Trace({ ignore })
  await trace.watch(context, APP)
  await page.goto(APP)
  await trace.settle()
  trace.act("Action", "they click")
  await page.click(button)
  const start = Date.now()
  await trace.settle()
  return Date.now() - start
}

test("a timer an ignored package arms is not waited for", async ({ context, page }) => {
  expect(await settleAfterClick(context, page, ["slowlib"], "#lib")).toBeLessThan(400)
})

test("a timer of a package not ignored is waited for", async ({ context, page }) => {
  expect(await settleAfterClick(context, page, [], "#lib")).toBeGreaterThanOrEqual(850)
})

test("a timer the app's own code arms is waited for whatever is ignored", async ({ context, page }) => {
  expect(await settleAfterClick(context, page, ["slowlib"], "#app")).toBeGreaterThanOrEqual(850)
})
