type Callback = (...args: unknown[]) => void

type Timer = { id: number; at: number; delay: number; every?: number; fn: Callback; args: unknown[]; created: number; ref: boolean; handle: Handle }

export type Native = {
  setTimeout: typeof setTimeout
  clearTimeout: typeof clearTimeout
  setImmediate: typeof setImmediate
  Date: DateConstructor
  now: () => number
}

// Node's rule for a delay it cannot use.
const longest = 2 ** 31 - 1
// Above any id Node gives a native timer, so a number is never taken for the wrong one.
const firstId = 1e12

export class Handle {
  constructor(
    private readonly clock: ServerClock,
    readonly id: number,
  ) {}

  ref(): this {
    this.clock.reference(this.id, true)
    return this
  }

  unref(): this {
    this.clock.reference(this.id, false)
    return this
  }

  hasRef(): boolean {
    return this.clock.referenced(this.id)
  }

  refresh(): this {
    this.clock.refresh(this.id)
    return this
  }

  close(): this {
    this.clock.clearOwn(this)
    return this
  }

  [Symbol.toPrimitive](): number {
    return this.id
  }
}

export class ServerClock {
  private ticks = 0
  private wall: number
  private fixed = false
  private real?: { since: number }
  private timers = new Map<number, Timer>()
  private nextId = firstId
  private wake?: ReturnType<typeof setTimeout>
  private waking?: Promise<void>
  private readonly start: number

  constructor(private readonly native: Native) {
    this.wall = native.Date.now()
    this.start = native.now()
    this.resume()
  }

  now(): number {
    this.sync()
    return Math.floor(this.wall)
  }

  performanceNow(): number {
    this.sync()
    return this.start + this.ticks
  }

  add(fn: Callback, delay: unknown, args: unknown[], repeat: boolean): Handle {
    let ms = Number(delay)
    if (!Number.isFinite(ms) || ms < 1 || ms > longest) {
      ms = 1
    }
    this.sync()
    const id = this.nextId++
    const handle = new Handle(this, id)
    this.timers.set(id, { id, at: this.ticks + ms, delay: ms, every: repeat ? ms : undefined, fn, args, created: this.ticks, ref: true, handle })
    this.schedule()
    return handle
  }

  clearOwn(timer: unknown): boolean {
    const id = timer instanceof Handle ? timer.id : Number(timer)
    if (!(timer instanceof Handle) && !this.timers.has(id)) {
      return false
    }
    this.timers.delete(id)
    this.schedule()
    return true
  }

  reference(id: number, on: boolean): void {
    const timer = this.timers.get(id)
    if (timer) {
      timer.ref = on
      this.schedule()
    }
  }

  referenced(id: number): boolean {
    return this.timers.get(id)?.ref ?? false
  }

  refresh(id: number): void {
    const timer = this.timers.get(id)
    if (timer) {
      this.sync()
      timer.at = this.ticks + timer.delay
      this.schedule()
    }
  }

  install(time?: number): void {
    if (time !== undefined) {
      this.setSystemTime(time)
    }
  }

  async runFor(ms: number): Promise<void> {
    if (ms < 0) {
      throw new TypeError("Negative ticks are not supported")
    }
    await this.withoutRealTime(() => this.runTo(this.ticks + ms))
  }

  async fastForward(ms: number): Promise<void> {
    await this.withoutRealTime(() => this.fastForwardTo(this.ticks + ms))
  }

  async pauseAt(time: number): Promise<void> {
    await this.pause()
    const by = time - this.wall
    if (by < 0) {
      throw new Error("Cannot fast-forward to the past")
    }
    await this.fastForwardTo(this.ticks + by)
    if (!this.fixed) {
      this.wall = time
    }
  }

  resume(): void {
    this.real = { since: this.native.now() }
    this.schedule()
  }

  setFixedTime(time: number): void {
    this.sync()
    this.wall = time
    this.fixed = true
  }

  setSystemTime(time: number): void {
    this.sync()
    this.wall = time
    this.fixed = false
  }

  private sync(): void {
    if (!this.real) {
      return
    }
    const now = this.native.now()
    if (now > this.real.since) {
      this.advance(this.ticks + now - this.real.since)
      this.real.since = now
    }
  }

  private advance(to: number): void {
    if (to <= this.ticks) {
      return
    }
    if (!this.fixed) {
      this.wall += to - this.ticks
    }
    this.ticks = to
  }

  private first(before = Infinity): Timer | undefined {
    let found: Timer | undefined
    for (const timer of this.timers.values()) {
      if (timer.at > before) {
        continue
      }
      if (!found || timer.at < found.at || (timer.at === found.at && (timer.created < found.created || (timer.created === found.created && timer.id < found.id)))) {
        found = timer
      }
    }
    return found
  }

  private async runTo(to: number): Promise<void> {
    let error: unknown
    for (let timer = this.first(to); timer; timer = this.first(to)) {
      this.advance(timer.at)
      if (timer.every === undefined) {
        this.timers.delete(timer.id)
      } else {
        timer.at += timer.every
      }
      try {
        timer.fn.apply(timer.handle, timer.args)
      } catch (e) {
        error ??= e
      }
      // What the timer queued runs before the next timer, as it would between native ones.
      await new Promise((done) => this.native.setImmediate(done))
    }
    this.advance(to)
    if (error !== undefined) {
      throw error
    }
  }

  private async fastForwardTo(to: number): Promise<void> {
    for (const timer of this.timers.values()) {
      timer.at = Math.max(timer.at, to)
    }
    await this.runTo(to)
  }

  private async pause(): Promise<void> {
    this.sync()
    this.real = undefined
    this.schedule()
    await this.waking
  }

  private async withoutRealTime(run: () => Promise<void>): Promise<void> {
    const running = this.real !== undefined
    await this.pause()
    try {
      await run()
    } finally {
      if (running) {
        this.resume()
      }
    }
  }

  private schedule(): void {
    if (this.wake !== undefined) {
      this.native.clearTimeout(this.wake)
      this.wake = undefined
    }
    if (!this.real || this.waking) {
      return
    }
    this.sync()
    const next = this.first()
    if (!next) {
      return
    }
    const wake = this.native.setTimeout(() => {
      this.wake = undefined
      this.sync()
      // A timer that throws takes the process down, as it does without the clock.
      this.waking = this.runTo(this.ticks)
        .catch((error: unknown) =>
          process.nextTick(() => {
            throw error
          }),
        )
        .finally(() => {
          this.waking = undefined
          this.schedule()
        })
    }, Math.max(0, next.at - this.ticks))
    if (![...this.timers.values()].some((timer) => timer.ref)) {
      wake.unref?.()
    }
    this.wake = wake
  }
}

function clockDate(clock: ServerClock, NativeDate: DateConstructor): DateConstructor {
  const ClockDate = function (this: unknown, ...args: unknown[]) {
    if (!new.target) {
      return new NativeDate(clock.now()).toString()
    }
    return args.length === 0 ? new NativeDate(clock.now()) : new (NativeDate as unknown as new (...a: unknown[]) => Date)(...args)
  }
  return Object.assign(ClockDate, {
    prototype: NativeDate.prototype,
    now: () => clock.now(),
    parse: NativeDate.parse,
    UTC: NativeDate.UTC,
    toString: () => NativeDate.toString(),
  }) as unknown as DateConstructor
}

export type Faked = Pick<typeof globalThis, "setTimeout" | "clearTimeout" | "setInterval" | "clearInterval">

export function installClock(scope: typeof globalThis): { clock: ServerClock; faked: Faked } {
  const native = {
    setTimeout: scope.setTimeout,
    clearTimeout: scope.clearTimeout,
    setInterval: scope.setInterval,
    clearInterval: scope.clearInterval,
    setImmediate: scope.setImmediate,
    Date: scope.Date,
    now: scope.performance.now.bind(scope.performance),
  }
  const clock = new ServerClock(native)
  const faked: Faked = {
    setTimeout: ((fn: unknown, delay?: unknown, ...args: unknown[]) =>
      typeof fn === "function" ? clock.add(fn as Callback, delay, args, false) : native.setTimeout(fn as Callback, delay as number, ...args)) as typeof setTimeout,
    setInterval: ((fn: unknown, delay?: unknown, ...args: unknown[]) =>
      typeof fn === "function"
        ? clock.add(fn as Callback, delay, args, true)
        : native.setInterval(fn as Callback, delay as number, ...args)) as unknown as typeof setInterval,
    clearTimeout: ((timer: unknown) => {
      if (!clock.clearOwn(timer)) {
        native.clearTimeout(timer as ReturnType<typeof setTimeout>)
      }
    }) as typeof clearTimeout,
    clearInterval: ((timer: unknown) => {
      if (!clock.clearOwn(timer)) {
        native.clearInterval(timer as ReturnType<typeof setInterval>)
      }
    }) as typeof clearInterval,
  }
  Object.assign(scope, faked)
  scope.Date = clockDate(clock, native.Date)
  scope.performance.now = () => clock.performanceNow()
  Object.defineProperty(scope.AbortSignal, "timeout", {
    configurable: true,
    writable: true,
    value: (ms: number) => {
      const controller = new AbortController()
      clock.add(() => controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")), ms, [], false).unref()
      return controller.signal
    },
  })
  return { clock, faked }
}
