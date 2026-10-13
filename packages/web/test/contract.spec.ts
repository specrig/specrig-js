import path from "node:path"
import { expect, test } from "@playwright/test"
import { Contract } from "../src/contract.js"

const file = path.join(import.meta.dirname, "fixtures", "shop.yaml")
const shop = new Contract(file, "shop", "Error")

test("an answer the backend can give passes", () => {
  expect(shop.response("GET", "/items/1", 404, { code: 404, message: "not found" })).toEqual([])
})

test("an answer in another shape than the contract's is refused", () => {
  expect(shop.response("GET", "/items/1", 404, { code: "not_found" })).not.toEqual([])
})

test("a status the route does not answer is refused, a failure of the server is not", () => {
  expect(shop.response("GET", "/items/1", 418, {})).toEqual(["GET /items/1 answered 418: shop does not answer 418 here"])
  expect(shop.response("GET", "/items/1", 503, { code: 503, message: "unavailable" })).toEqual([])
  expect(shop.response("GET", "/items/1", 503, { reason: "unavailable" })).not.toEqual([])
})

test("without a failure schema a failure the route does not document is refused", () => {
  expect(new Contract(file, "shop").response("GET", "/items/1", 503, { code: 503, message: "x" })).not.toEqual([])
})

test("a request body the backend would not accept is refused", () => {
  expect(shop.request("POST", "/items/new", { count: 1 })).not.toEqual([])
  expect(shop.request("POST", "/items/new", { name: "box", count: 1 })).toEqual([])
})

test("a route the backend does not serve is refused", () => {
  expect(shop.request("DELETE", "/items/1", undefined)).toEqual(["DELETE /items/1: shop serves no such route"])
})

test("the template with the most constant segments takes the request", () => {
  expect(shop.response("GET", "/items/new", 200, { draft: true })).toEqual([])
  expect(shop.response("GET", "/items/new", 200, { id: "new" })).not.toEqual([])
})
