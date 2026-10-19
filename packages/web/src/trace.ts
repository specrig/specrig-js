import type { BrowserContext, Frame, Page, Request } from "@playwright/test"
import type { Traced } from "./flows.js"

// A timer of up to a second is how a page puts off what it sends: a debounce, a retry.
const short = 1000
// What a page arms within a second of a step still belongs to it; a timer that keeps
// re-arming itself past that is a clock, and nothing waits for it.
const horizon = 1000
const quiet = 50
const binding = "__specrigTimer"

// What the app sends after an action belongs to it until the next action or set-up:
// a page answers a click later than the step that clicked returns, or puts it off.
export class Trace {
  readonly records: Traced[] = []
  scenario?: { feature: string; scenario: string }
  private step = ""
  private pending = new Set<Request>()
  private timers = new Map<Frame, Map<number, number>>()
  private until = Infinity
  private lastActivity = 0

  async watch(context: BrowserContext): Promise<void> {
    context.on("request", (request) => this.started(request))
    context.on("requestfinished", (request) => this.finished(request))
    context.on("requestfailed", (request) => this.finished(request))
    const listen = (page: Page) => page.on("framenavigated", (frame) => this.navigated(frame))
    context.pages().forEach(listen)
    context.on("page", listen)
    await context.exposeBinding(binding, ({ frame }, event: "armed" | "done", id: number) =>
      event === "armed" ? this.armed(frame, id) : this.done(frame, id),
    )
    await context.addInitScript(timers, { binding, short })
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

  private armed(frame: Frame, id: number): void {
    const armed = this.timers.get(frame) ?? this.timers.set(frame, new Map()).get(frame)!
    armed.set(id, Date.now())
  }

  // A timer is done before the page sends what it fired, so it counts as activity, unless it was past the horizon.
  private done(frame: Frame, id: number): void {
    const at = this.timers.get(frame)?.get(id)
    this.timers.get(frame)?.delete(id)
    if (at !== undefined && at <= this.until) {
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

  // A click returns before the page sends what it caused, so after an action the quiet is counted from now too.
  async settle(): Promise<void> {
    const start = Date.now()
    const since = this.step === "Action" ? start : 0
    const busy = () =>
      this.pending.size > 0 || this.waiting() || Date.now() - Math.max(this.lastActivity, since) < quiet
    this.until = start + horizon
    try {
      while (busy() && Date.now() < start + 5000) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    } finally {
      this.until = Infinity
    }
  }

  private waiting(): boolean {
    for (const [frame, armed] of this.timers) {
      if (!frame.isDetached() && [...armed.values()].some((at) => at <= this.until)) {
        return true
      }
    }
    return false
  }
}

// Runs in every document before the app: tells the harness when a timer of up to `short`
// is armed, and when it is done, fired or cleared. An interval is never done, so it is
// not told, nor is a callback given as a string.
function timers({ binding, short }: { binding: string; short: number }): void {
  const { setTimeout: arm, clearTimeout: clear } = window
  const armed = new Set<number>()
  let telling = false
  const tell = (event: "armed" | "done", id: number) => {
    const report = (window as unknown as Record<string, unknown>)[binding] as
      | ((event: string, id: number) => Promise<void>)
      | undefined
    telling = true
    try {
      report?.(event, id).catch(() => {})
    } finally {
      telling = false
    }
  }
  window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (telling || typeof handler !== "function" || (Number(delay) || 0) > short) {
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
    tell("armed", id)
    return id
  }) as typeof window.setTimeout
  window.clearTimeout = window.clearInterval = ((id?: number) => {
    if (id !== undefined && armed.delete(id)) {
      tell("done", id)
    }
    clear(id)
  }) as typeof window.clearTimeout
}
