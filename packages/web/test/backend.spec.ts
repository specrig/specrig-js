import path from "node:path"
import { type BrowserContext, expect, type Page, type Route, test } from "@playwright/test"
import { Backend } from "../src/backend.js"
import { Contract } from "../src/contract.js"
import { Trace } from "../src/trace.js"

type Answer = { status?: number; json?: unknown }

async function ask(backend: Backend, method: string, url: string, body?: unknown): Promise<Answer> {
  let answer: Answer = {}
  const route = {
    request: () => ({ method: () => method, url: () => url, postData: () => (body === undefined ? null : JSON.stringify(body)) }),
    fulfill: async (a: Answer) => {
      answer = a
    },
  } as unknown as Route
  await backend.answer(route)
  return answer
}

// A request that may wait for its answer: what it was answered with, once it is.
async function send(backend: Backend, method: string, url: string, failure: string | null = null) {
  const sent: { answer?: Answer } = {}
  const request = { method: () => method, url: () => url, postData: () => null, failure: () => failure && { errorText: failure } }
  const route = {
    request: () => request,
    fulfill: async (a: Answer) => {
      sent.answer = a
    },
  } as unknown as Route
  await backend.answer(route)
  return sent
}

const quote = (label: string) => ({ label })

test("the most specific reply the query matches answers", async () => {
  const shop = new Backend(new Trace())
  shop.reply("GET", "/prices", 200, quote("any"))
  shop.replyTo("GET", "/prices", { code: "S2" }, 200, quote("S2"))
  shop.replyTo("GET", "/prices", { code: "S2", promo: "SUMMER" }, 200, quote("S2 SUMMER"))
  shop.replyTo("GET", "/prices", { "period[]": ["1w", "1m"] }, 200, quote("1w 1m"))

  expect((await ask(shop, "GET", "https://shop.test/prices?code=S1")).json).toEqual(quote("any"))
  expect((await ask(shop, "GET", "https://shop.test/prices?code=S2&facility=F1")).json).toEqual(quote("S2"))
  expect((await ask(shop, "GET", "https://shop.test/prices?code=S2&promo=SUMMER")).json).toEqual(quote("S2 SUMMER"))
  expect((await ask(shop, "GET", "https://shop.test/prices?period[]=1w&period[]=1m")).json).toEqual(quote("1w 1m"))
  expect((await ask(shop, "GET", "https://shop.test/prices?period[]=1w")).json).toEqual(quote("any"))
})

test("a reply declared again for the same query replaces the first", async () => {
  const shop = new Backend(new Trace())
  shop.replyTo("GET", "/prices", { code: "S2" }, 200, quote("first"))
  shop.replyTo("GET", "/prices", { code: "S2" }, 404, quote("second"))

  expect(await ask(shop, "GET", "https://shop.test/prices?code=S2")).toMatchObject({ status: 404, json: quote("second") })
})

test("a call no reply answers is recorded and refused", async () => {
  const shop = new Backend(new Trace())

  expect((await ask(shop, "GET", "https://shop.test/prices?code=S1")).status).toBe(501)
  expect(shop.unanswered).toEqual(["GET /prices?code=S1"])
})

test("what the contract does not allow is recorded on either side", async () => {
  const contract = new Contract(path.join(import.meta.dirname, "fixtures", "shop.yaml"), "shop", "Error")
  const shop = new Backend(new Trace(), contract)
  shop.reply("GET", "/items/1", 200, { name: "box" })

  await ask(shop, "GET", "https://shop.test/items/1")
  await ask(shop, "DELETE", "https://shop.test/items/1")

  expect(shop.violations).toHaveLength(2)
})

test("a request is traced as the contract's route that takes it", async () => {
  const trace = new Trace()
  const shop = new Backend(trace, new Contract(path.join(import.meta.dirname, "fixtures", "shop.yaml"), "shop"))
  shop.reply("GET", "/items/7", 200, {})
  shop.reply("GET", "/items/new", 200, {})

  await ask(shop, "GET", "https://shop.test/items/7")
  await ask(shop, "GET", "https://shop.test/items/new")

  expect(trace.records.map((r) => r.name)).toEqual(["GET /items/{id}", "GET /items/new"])
})

test("a request to a backend with no contract is traced as it was sent", async () => {
  const trace = new Trace()
  const shop = new Backend(trace)
  shop.reply("GET", "/items/7", 200, {})

  await ask(shop, "GET", "https://shop.test/items/7")

  expect(trace.records.map((r) => r.name)).toEqual(["GET /items/7"])
})

test("a held request waits, and is answered on release with what the backend answers by then", async () => {
  const shop = new Backend(new Trace())
  shop.hold("GET", "/items")

  const sent = await send(shop, "GET", "https://shop.test/items")
  expect(sent.answer).toBeUndefined()

  shop.reply("GET", "/items", 200, [quote("Tea")])
  await shop.release("GET", "/items")
  expect(sent.answer).toMatchObject({ status: 200, json: [quote("Tea")] })
})

test("a request that comes after the release is answered at once", async () => {
  const shop = new Backend(new Trace())
  shop.reply("GET", "/items", 200, [])
  shop.hold("GET", "/items")
  await shop.release("GET", "/items")

  expect((await send(shop, "GET", "https://shop.test/items")).answer).toMatchObject({ status: 200 })
})

test("the hold naming the most of the query takes the request, and each is released on its own", async () => {
  const shop = new Backend(new Trace())
  shop.reply("GET", "/items", 200, [])
  shop.hold("GET", "/items", { q: "te" })
  shop.hold("GET", "/items", { q: "tea" })

  const te = await send(shop, "GET", "https://shop.test/items?q=te")
  const tea = await send(shop, "GET", "https://shop.test/items?q=tea")
  await shop.release("GET", "/items", { q: "tea" })

  expect([te.answer, tea.answer]).toEqual([undefined, expect.objectContaining({ status: 200 })])
  await shop.release("GET", "/items", { q: "te" })
  expect(te.answer).toMatchObject({ status: 200 })
})

test("an answer no step released is named, unless the app gave up on the request", async () => {
  const shop = new Backend(new Trace())
  shop.hold("GET", "/items")

  await send(shop, "GET", "https://shop.test/items?q=te", "net::ERR_ABORTED")
  await send(shop, "GET", "https://shop.test/items?q=tea")

  expect(shop.unreleased).toEqual(["GET /items?q=tea"])
})

test("releasing what no step held is refused", async () => {
  const shop = new Backend(new Trace())
  shop.hold("GET", "/items", { q: "te" })

  await expect(shop.release("GET", "/items")).rejects.toThrow("GET /items")
})

// A page whose button runs `click`, and whose /items the backend stand-in answers.
async function shopping(context: BrowserContext, page: Page, click: string) {
  const trace = new Trace()
  await trace.watch(context)
  const shop = new Backend(trace)
  await context.route("https://shop.test/**", async (route) => {
    if (new URL(route.request().url()).pathname === "/items") {
      await shop.answer(route)
    } else {
      await route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><button>Go</button><script>document.querySelector("button").onclick = () => { ${click} }</script>`,
      })
    }
  })
  await page.goto("https://shop.test/")
  trace.act("Action", "they click Go")
  return { trace, shop }
}

test("a held answer does not keep the step waiting, and the page takes it once released", async ({ context, page }) => {
  const { trace, shop } = await shopping(
    context,
    page,
    `fetch("/items").then((r) => r.json()).then((items) => { document.title = items[0].label })`,
  )
  shop.reply("GET", "/items", 200, [quote("Tea")])
  shop.hold("GET", "/items")

  await page.getByRole("button").click()
  const start = Date.now()
  await trace.settle()
  expect(Date.now() - start).toBeLessThan(150)
  expect(await page.title()).toBe("")

  await shop.release("GET", "/items")
  await expect(page).toHaveTitle("Tea")
})

test("a request the app gives up on, once the test's clock passes its timeout, is not named", async ({ context, page }) => {
  const { trace, shop } = await shopping(
    context,
    page,
    `fetch("/items", { signal: AbortSignal.timeout(10000) }).catch(() => { document.title = "gave up" })`,
  )
  await page.clock.install()
  shop.hold("GET", "/items")

  await page.getByRole("button").click()
  await trace.settle()
  await page.clock.runFor(10000)

  await expect(page).toHaveTitle("gave up")
  await trace.settle()
  expect(shop.unreleased).toEqual([])
})
