import { expect, test } from "@playwright/test"
import { installClock } from "../src/server-clock.js"

// A scope of its own, so the clock fakes nothing the test runner keeps time with.
function scope() {
  const own = {
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    setImmediate,
    Date,
    performance: { now: performance.now.bind(performance) },
    AbortSignal: class extends AbortSignal {},
  } as unknown as typeof globalThis
  return { own, ...installClock(own) }
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

test("a timer fires once the clock runs past it, and not before", async () => {
  const { own, clock } = scope()
  const fired: string[] = []
  own.setTimeout(() => fired.push("later"), 1000)

  await clock.runFor(999)
  expect(fired).toEqual([])
  await clock.runFor(1)
  expect(fired).toEqual(["later"])
})

test("the time runs with the real one until it is paused", async () => {
  const { own, clock } = scope()
  expect(Math.abs(own.Date.now() - Date.now())).toBeLessThan(50)

  await clock.pauseAt(Date.parse("2030-01-01T00:00:00Z"))
  await sleep(30)

  expect(new own.Date().toISOString()).toBe("2030-01-01T00:00:00.000Z")
})

test("a timer due while the time runs fires on its own", async () => {
  const { own } = scope()
  const fired = new Promise<string>((done) => own.setTimeout(() => done("fired"), 20))

  expect(await fired).toBe("fired")
})

test("running the clock fires an interval each time it is due, fast-forwarding fires it once", async () => {
  const { own, clock } = scope()
  let ticks = 0
  own.setInterval(() => ticks++, 100)

  await clock.runFor(1000)
  expect(ticks).toBe(10)
  await clock.fastForward(1000)
  expect(ticks).toBe(11)
})

test("a fixed time holds the date while the timers keep running", async () => {
  const { own, clock } = scope()
  clock.setFixedTime(Date.parse("2026-03-01T10:00:00Z"))

  await new Promise((done) => own.setTimeout(done, 20))

  expect(own.Date.now()).toBe(Date.parse("2026-03-01T10:00:00Z"))
})

test("a timeout signal aborts when the clock passes it", async () => {
  const { own, clock } = scope()
  await clock.pauseAt(Date.now() + 1000)
  const signal = own.AbortSignal.timeout(5000)

  await clock.runFor(4999)
  expect(signal.aborted).toBe(false)
  await clock.runFor(1)
  expect((signal.reason as DOMException).name).toBe("TimeoutError")
})

test("a timer is cleared by its handle or by its number", async () => {
  const { own, clock } = scope()
  const fired: number[] = []
  const first = own.setTimeout(() => fired.push(1), 10)
  const second = own.setTimeout(() => fired.push(2), 10)

  own.clearTimeout(first)
  own.clearTimeout(Number(second) as unknown as ReturnType<typeof setTimeout>)
  await clock.runFor(100)

  expect(fired).toEqual([])
})

test("a timer armed by a timer fires in the same run when it is due", async () => {
  const { own, clock } = scope()
  const fired: string[] = []
  own.setTimeout(() => {
    fired.push("first")
    own.setTimeout(() => fired.push("second"), 100)
  }, 100)

  await clock.runFor(200)

  expect(fired).toEqual(["first", "second"])
})

test("the clock's date reads as the native one does", () => {
  const { own } = scope()

  expect(new own.Date(2026, 2, 1).getFullYear()).toBe(2026)
  expect(new own.Date()).toBeInstanceOf(Date)
  expect(typeof (own.Date as unknown as () => string)()).toBe("string")
})
