import { type BrowserContext, expect, type Page, test } from "@playwright/test"
import { Trace } from "../src/trace.js"

// A shop whose button runs `click`; what reaches /items is kept by its query.
async function shop(context: BrowserContext, page: Page, click: string) {
  const trace = new Trace()
  await trace.watch(context)
  const sent: string[] = []
  await context.route("https://shop.test/**", async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/items") {
      sent.push(url.search)
      await route.fulfill({ status: Number(url.searchParams.get("status") ?? 200), json: [] })
    } else {
      await route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><button>Go</button><script>document.querySelector("button").onclick = () => { ${click} }</script>`,
      })
    }
  })
  await page.goto("https://shop.test/")
  return { trace, sent }
}

// The step clicks, and the harness settles before the next one: how long that took.
async function act(page: Page, trace: Trace): Promise<number> {
  trace.act("Action", "they click Go")
  await page.getByRole("button").click()
  const start = Date.now()
  await trace.settle()
  return Date.now() - start
}

test("a request a debounce sends after the action is waited for", async ({ context, page }) => {
  const { trace, sent } = await shop(context, page, `setTimeout(() => fetch("/items"), 300)`)

  await act(page, trace)

  expect(sent).toEqual([""])
})

test("a request a timer of a second sends is waited for", async ({ context, page }) => {
  const { trace, sent } = await shop(context, page, `setTimeout(() => fetch("/items"), 1000)`)

  await act(page, trace)

  expect(sent).toEqual([""])
})

test("a retry armed after a failed request is waited for", async ({ context, page }) => {
  const { trace, sent } = await shop(
    context,
    page,
    `fetch("/items?status=500").then(() => setTimeout(() => fetch("/items"), 1000))`,
  )

  await act(page, trace)

  expect(sent).toEqual(["?status=500", ""])
})

test("an action that arms nothing and sends nothing settles at once", async ({ context, page }) => {
  const { trace } = await shop(context, page, ``)

  expect(await act(page, trace)).toBeLessThan(150)
})

test("a timer longer than a second is not waited for", async ({ context, page }) => {
  const { trace, sent } = await shop(context, page, `setTimeout(() => fetch("/items"), 1500)`)

  expect(await act(page, trace)).toBeLessThan(150)
  expect(sent).toEqual([])
})

test("a timer cleared before it fires is not waited for", async ({ context, page }) => {
  const { trace } = await shop(context, page, `clearTimeout(setTimeout(() => fetch("/items"), 300))`)

  expect(await act(page, trace)).toBeLessThan(150)
})

test("an interval is not waited for", async ({ context, page }) => {
  const { trace } = await shop(context, page, `setInterval(() => {}, 100)`)

  expect(await act(page, trace)).toBeLessThan(150)
})

test("a timer that re-arms itself is waited for no longer than a second past the action", async ({ context, page }) => {
  const { trace } = await shop(context, page, `const tick = () => setTimeout(tick, 200); tick()`)

  expect(await act(page, trace)).toBeLessThan(1500)
})

test("a request the page sends once it has rendered an answer is waited for", async ({ context, page }) => {
  const { trace, sent } = await shop(
    context,
    page,
    `fetch("/items").then((r) => r.json()).then(() => {
      const begun = performance.now()
      while (performance.now() - begun < 150) {}
      fetch("/items?page=2")
    })`,
  )

  await act(page, trace)

  expect(sent).toEqual(["", "?page=2"])
})

test("a page under the test's clock settles at once", async ({ context, page }) => {
  const { trace } = await shop(context, page, ``)
  await page.clock.setFixedTime(new Date("2026-03-01T10:00:00"))

  expect(await act(page, trace)).toBeLessThan(150)
})

test("a debounce under the test's clock is waited for", async ({ context, page }) => {
  const { trace, sent } = await shop(context, page, `setTimeout(() => fetch("/items"), 300)`)
  await page.clock.setFixedTime(new Date("2026-03-01T10:00:00"))

  await act(page, trace)

  expect(sent).toEqual([""])
})

test("a timer the test's paused clock holds is not waited for past when it was due", async ({ context, page }) => {
  const { trace, sent } = await shop(context, page, `setTimeout(() => fetch("/items"), 300)`)
  await page.clock.install({ time: new Date("2026-03-01T10:00:00") })
  await page.clock.pauseAt(new Date("2026-03-01T10:00:01"))

  expect(await act(page, trace)).toBeLessThan(800)
  expect(sent).toEqual([])
})

test("a frame's new document ends the timers its old one armed", async ({ context, page }) => {
  const { trace, sent } = await shop(context, page, `setTimeout(() => fetch("/items"), 800); location.href = "/next"`)

  expect(await act(page, trace)).toBeLessThan(500)
  expect(sent).toEqual([])
})
