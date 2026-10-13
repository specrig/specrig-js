import path from "node:path"
import { expect, type Route, test } from "@playwright/test"
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
