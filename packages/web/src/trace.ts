import type { BrowserContext, Frame, Page, Request } from "@playwright/test"
import type { Traced } from "./flows.js"

// A timer of up to a second is how a page puts off what it sends: a debounce, a retry.
const short = 1000
// What a page arms within a second of a step still belongs to it; a timer that keeps
// re-arming itself past that is a clock, and nothing waits for it.
const horizon = 1000
// A timer not done this long after it was due is held by the test's clock, not the page.
const late = 100
const quiet = 50
const binding = "__specrigTimer"
const idle = "__specrigIdle"

type Armed = { at: number; due: number }

// What the app sends after an action belongs to it until the next action or set-up:
// a page answers a click later than the step that clicked returns, or puts it off.
export class Trace {
  readonly records: Traced[] = []
  scenario?: { feature: string; scenario: string }
  private step = ""
  private context?: BrowserContext
  private pending = new Set<Request>()
  private timers = new Map<Frame, Map<number, Armed>>()
  private until = Infinity
  private lastActivity = 0

  async watch(context: BrowserContext): Promise<void> {
    this.context = context
    context.on("request", (request) => this.started(request))
    context.on("requestfinished", (request) => this.finished(request))
    context.on("requestfailed", (request) => this.finished(request))
    const listen = (page: Page) => page.on("framenavigated", (frame) => this.navigated(frame))
    context.pages().forEach(listen)
    context.on("page", listen)
    await context.exposeBinding(binding, ({ frame }, event: "armed" | "done", id: number, delay: number) =>
      event === "armed" ? this.armed(frame, id, delay) : this.done(frame, id),
    )
    await context.addInitScript(timers, { binding, idle, short })
  }

  started(request: Request): void {
    this.pending.add(request)
    this.lastActivity = Date.now()
  }

  finished(request: Request): void {
    this.pending.delete(request)
    this.lastActivity = Date.now()
  }

  // A frame's new document ends what the old one had in flight or armed, and no event says so.
  navigated(frame: Frame): void {
    for (const request of this.pending) {
      if (request.frame() === frame) {
        this.pending.delete(request)
      }
    }
    this.timers.delete(frame)
  }

  private armed(frame: Frame, id: number, delay: number): void {
    const armed = this.timers.get(frame) ?? this.timers.set(frame, new Map()).get(frame)!
    armed.set(id, { at: Date.now(), due: Date.now() + delay })
  }

  // A timer is done before the page sends what it fired, so it counts as activity, unless it was past the horizon.
  private done(frame: Frame, id: number): void {
    const timer = this.timers.get(frame)?.get(id)
    this.timers.get(frame)?.delete(id)
    if (timer && timer.at <= this.until) {
      this.lastActivity = Date.now()
    }
  }

  act(type: string, text: string): void {
    if (type !== "Outcome") {
      this.step = type
    }
    if (type === "Action") {
      this.records.push({ seq: this.records.length, dir: "in", kind: "ui", name: text, step: type })
    }
  }

  sent(route: string, body: unknown): void {
    this.records.push({ seq: this.records.length, dir: "out", kind: "http", name: route, body, step: this.step })
  }

  // The quiet is counted once the pages have run what they had queued: a page reads an
  // answer and renders it before it sends what the render asks for. Whatever happened
  // meanwhile is waited out the same way again.
  async settle(): Promise<void> {
    const start = Date.now()
    const deadline = start + 5000
    this.until = start + horizon
    try {
      for (;;) {
        const before = this.lastActivity
        await this.idle(deadline)
        // A click returns before the page sends what it caused, so after an action the quiet is counted from now too.
        const since = this.step === "Action" ? Date.now() : 0
        while (this.busy(since) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        if (this.lastActivity === before || Date.now() >= deadline) {
          return
        }
      }
    } finally {
      this.until = Infinity
    }
  }

  private busy(since: number): boolean {
    return this.pending.size > 0 || this.waiting() || Date.now() - Math.max(this.lastActivity, since) < quiet
  }

  private waiting(): boolean {
    const now = Date.now()
    for (const [frame, armed] of this.timers) {
      if (!frame.isDetached() && [...armed.values()].some((t) => t.at <= this.until && now <= t.due + late)) {
        return true
      }
    }
    return false
  }

  private async idle(deadline: number): Promise<void> {
    const frames = this.context?.pages().flatMap((page) => page.frames()) ?? []
    const all = frames.map((frame) =>
      frame
        .evaluate((name) => (window as unknown as Record<string, (() => Promise<void>) | undefined>)[name]?.(), idle)
        .catch(() => {}),
    )
    await Promise.race([Promise.all(all), new Promise((resolve) => setTimeout(resolve, deadline - Date.now()))])
  }
}

// Runs in every document before the app. Tells the harness when a timer of up to `short`
// is armed through setTimeout as the app sees it, and when that timer is done: fired or
// cleared. What is put in setTimeout's place later, such as the test's clock, is watched
// the same way, and the timers it arms through the setTimeout it replaced are its own.
// An interval is never done, so it is not told, nor is a callback given as a string.
// `window[idle]()` resolves once the main thread has run what it had queued: a message
// to itself, queued as a render's next slice is, twice comes back with nothing run
// before it. requestIdleCallback cannot say so, as Chrome holds it back after input.
function timers({ binding, idle, short }: { binding: string; idle: string; short: number }): void {
  type Arm = (handler: TimerHandler, delay?: number, ...args: unknown[]) => number
  type Clear = (id?: number) => void
  const scope = window as unknown as Record<string, unknown>
  const armed = new Set<number>()
  let telling = false
  const tell = (event: "armed" | "done", id: number, delay?: number) => {
    const report = scope[binding] as ((event: string, id: number, delay?: number) => Promise<void>) | undefined
    telling = true
    try {
      report?.(event, id, delay).catch(() => {})
    } finally {
      telling = false
    }
  }
  // The function under `name` is wrapped, and so is whatever is put in its place later.
  const hook = <F extends Arm | Clear>(name: string, wrap: (fn: F) => F): (() => F) => {
    const ours = new WeakSet<F>()
    let current = scope[name] as F
    const take = (fn: F) => {
      current = ours.has(fn) ? fn : wrap(fn)
      ours.add(current)
    }
    take(current)
    Object.defineProperty(window, name, { configurable: true, enumerable: true, get: () => current, set: take })
    return () => current
  }
  const now = performance.now.bind(performance)
  const arming = hook<Arm>("setTimeout", (arm) => {
    const tracked: Arm = (handler, delay, ...args) => {
      const after = Number(delay) || 0
      if (telling || arming() !== tracked || typeof handler !== "function" || after > short) {
        return arm(handler, delay, ...args)
      }
      const id = arm(() => {
        armed.delete(id)
        try {
          handler.apply(window, args)
        } finally {
          tell("done", id)
        }
      }, delay)
      armed.add(id)
      tell("armed", id, after)
      return id
    }
    return tracked
  })
  const untrack = (clear: Clear): Clear => (id) => {
    if (id !== undefined && armed.delete(id)) {
      tell("done", id)
    }
    clear(id)
  }
  hook<Clear>("clearTimeout", untrack)
  hook<Clear>("clearInterval", untrack)
  Object.defineProperty(window, idle, {
    value: () =>
      new Promise<void>((resolve) => {
        const channel = new MessageChannel()
        let sent = now()
        let calm = 0
        channel.port1.onmessage = () => {
          calm = now() - sent < 2 ? calm + 1 : 0
          if (calm === 2) {
            channel.port1.close()
            resolve()
          } else {
            sent = now()
            channel.port2.postMessage(0)
          }
        }
        channel.port2.postMessage(0)
      }),
  })
}
