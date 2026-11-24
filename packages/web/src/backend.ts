import type { Route } from "@playwright/test"
import type { Contract } from "./contract.js"
import { overlap, type Route as Served, route, routeOf, spell } from "./routes.js"
import type { Trace } from "./trace.js"

export type Query = Record<string, string | string[]>

export type Headers = Record<string, string>

export type Received = {
  method: string
  path: string
  query: URLSearchParams
  body: unknown
}

export type Answer = (received: Received) => [status: number, body?: unknown]

export type Reply = { query: Query; answer: Answer; headers?: Headers }

export type Fulfilment = { status: number; headers: Headers; json?: unknown; body?: string | Buffer }

export type Exchange = {
  method: string
  url: URL
  body: string | null
  ticket: object
  fulfill(answer: Fulfilment): Promise<void>
  gaveUp(): boolean
}

type Hold = { query: Query; waiting: Exchange[] }

export type Frame = string | object

export type Conversation = {
  open?: () => Frame[]
  message?: (frame: unknown) => Frame[]
}

export type Socket = {
  url: URL
  send(text: string): void
  close(): void
  onMessage(handler: (text: string) => void): void
  onClose(handler: () => void): void
}

type Open = { path: string; socket: Socket; closed: boolean }

const encode = (frame: Frame) => (typeof frame === "string" ? frame : JSON.stringify(frame))

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE",
  "access-control-allow-headers": "content-type, authorization",
}

export class Backend {
  private replies = new Map<string, Reply[]>()
  private holds = new Map<string, Hold[]>()
  private conversations = new Map<string, Conversation[]>()
  private open: Open[] = []
  private heard: { path: string; frame: unknown }[] = []
  readonly received: Received[] = []
  readonly unanswered: string[] = []
  readonly violations: string[] = []

  constructor(
    private readonly trace: Trace,
    private readonly contract?: Contract,
    private readonly own?: { name: string; routes: Served[] },
  ) {}

  private claim(method: string, path: string): void {
    if (this.own && !this.own.routes.some((r) => overlap(r, route(`${method} ${path}`)))) {
      throw new Error(`${method} ${path} is not one of ${this.own.name}'s routes`)
    }
  }

  private named(method: string, path: string): string {
    if (this.contract) {
      return this.contract.name(method, path)
    }
    const owned = this.own && routeOf(this.own.routes, method, path)
    return owned ? spell(owned) : `${method} ${path}`
  }

  reply(method: string, path: string, status: number, body?: unknown, headers?: Headers): void {
    this.replyTo(method, path, {}, status, body, headers)
  }

  replyTo(method: string, path: string, query: Query, status: number, body?: unknown, headers?: Headers): void {
    this.declare(method, path, { query, answer: () => [status, body], headers })
  }

  replyWith(method: string, path: string, answer: Answer, headers?: Headers): void {
    this.declare(method, path, { query: {}, answer, headers })
  }

  private declare(method: string, path: string, reply: Reply): void {
    this.claim(method, path)
    const key = `${method} ${path}`
    const others = (this.replies.get(key) ?? []).filter((r) => !sameQuery(r.query, reply.query))
    this.replies.set(key, [...others, reply])
  }

  // The requests the query takes wait until a step releases them: what the app shows while
  // it waits, which of two answers it takes first, and that it gives up on one in time.
  hold(method: string, path: string, query: Query = {}): void {
    this.claim(method, path)
    const key = `${method} ${path}`
    const others = (this.holds.get(key) ?? []).filter((h) => !sameQuery(h.query, query))
    this.holds.set(key, [...others, { query, waiting: [] }])
  }

  // What the hold kept waiting is answered with what the backend answers by now, and what comes later at once.
  async release(method: string, path: string, query: Query = {}): Promise<void> {
    const key = `${method} ${path}`
    const holds = this.holds.get(key) ?? []
    const hold = holds.find((h) => sameQuery(h.query, query))
    if (!hold) {
      throw new Error(`no step held ${key}${size(query) > 0 ? ` ${JSON.stringify(query)}` : ""}`)
    }
    this.holds.set(key, holds.filter((h) => h !== hold))
    for (const exchange of hold.waiting) {
      this.trace.released(exchange.ticket)
      await this.fulfill(exchange)
    }
  }

  get unreleased(): string[] {
    return [...this.holds.values()]
      .flat()
      .flatMap((h) => h.waiting)
      .filter((exchange) => !exchange.gaveUp())
      .map((exchange) => `${exchange.method} ${exchange.url.pathname}${exchange.url.search}`)
  }

  requests(method: string, path: string): Received[] {
    return this.received.filter((r) => r.method === method && takes(path, r.path))
  }

  socket(path: string, conversation: Conversation = {}): void {
    this.claim("WS", path)
    this.conversations.set(`WS ${path}`, [conversation])
  }

  frames(path: string): unknown[] {
    return this.heard.filter((h) => takes(path, h.path)).map((h) => h.frame)
  }

  // A step pushes once the page has the socket open: it opens on its own time, not the step's.
  async push(path: string, frame: Frame): Promise<void> {
    const deadline = Date.now() + 5000
    let open = this.open.filter((o) => !o.closed && takes(path, o.path))
    while (open.length === 0) {
      if (Date.now() > deadline) {
        throw new Error(`no socket is open on ${path} to push to`)
      }
      await new Promise((wait) => setTimeout(wait, 20))
      open = this.open.filter((o) => !o.closed && takes(path, o.path))
    }
    for (const o of open) {
      o.socket.send(encode(frame))
    }
    this.trace.touch()
  }

  connect(socket: Socket): void {
    const path = socket.url.pathname
    const conversation = declared(this.conversations, "WS", path)[0]
    if (!conversation) {
      this.unanswered.push(`WS ${path}${socket.url.search}`)
      socket.close()
      return
    }
    const open: Open = { path, socket, closed: false }
    this.open.push(open)
    const say = (frames: Frame[]) => {
      for (const frame of frames) {
        socket.send(encode(frame))
      }
      this.trace.touch()
    }
    socket.onMessage((text) => {
      const frame = parseBody(text)
      this.heard.push({ path, frame })
      this.trace.touch()
      say(conversation.message?.(frame) ?? [])
    })
    socket.onClose(() => {
      open.closed = true
    })
    say(conversation.open?.() ?? [])
  }

  async answer(route: Route): Promise<void> {
    const request = route.request()
    await this.take({
      method: request.method(),
      url: new URL(request.url()),
      body: request.postData(),
      ticket: request,
      fulfill: (answer) => route.fulfill(answer),
      gaveUp: () => request.failure() !== null,
    })
  }

  async take(exchange: Exchange): Promise<void> {
    const { method, url } = exchange
    if (method === "OPTIONS") {
      await exchange.fulfill({ status: 204, headers: cors })
      return
    }

    const got = received(exchange)
    this.received.push(got)
    this.trace.sent(this.named(method, url.pathname), got.body)
    this.violations.push(...(this.contract?.request(method, url.pathname, got.body) ?? []))

    const hold = pick(declared(this.holds, method, url.pathname), url.searchParams)
    if (hold) {
      hold.waiting.push(exchange)
      this.trace.held(exchange.ticket)
      return
    }
    await this.trace.turn(exchange.ticket)
    await this.fulfill(exchange)
  }

  private async fulfill(exchange: Exchange): Promise<void> {
    const answer = this.answerTo(exchange)
    // The app may have given up on it while it waited: there is no one left to answer.
    await exchange.fulfill(answer).catch(() => {})
  }

  private answerTo(exchange: Exchange): Fulfilment {
    const { method, url } = exchange
    const key = `${method} ${url.pathname}`
    const reply = pick(declared(this.replies, method, url.pathname), url.searchParams)
    if (!reply) {
      this.unanswered.push(`${key}${url.search}`)
      return { status: 501, headers: cors, json: { code: "unanswered", message: key } }
    }
    const [status, body] = reply.answer(received(exchange))
    this.violations.push(...(this.contract?.response(method, url.pathname, status, body ?? {}) ?? []))
    const headers = { ...cors, ...reply.headers }
    if (status === 204) {
      return { status, headers }
    }
    const type = Object.entries(headers).find(([name]) => name.toLowerCase() === "content-type")?.[1]
    if (type && !/json/i.test(type)) {
      return { status, headers, body: typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body ?? "") }
    }
    return { status, headers, json: body ?? {} }
  }
}

function received(exchange: Exchange): Received {
  const { method, url, body } = exchange
  return { method, path: url.pathname, query: url.searchParams, body: parseBody(body) }
}

function declared<T>(declarations: Map<string, T[]>, method: string, path: string): T[] {
  const exact = declarations.get(`${method} ${path}`)
  if (exact) {
    return exact
  }
  const prefix = `${method} `
  const template = [...declarations.keys()].find((key) => key.startsWith(prefix) && takes(key.slice(prefix.length), path))
  return template ? declarations.get(template)! : []
}

function takes(template: string, path: string): boolean {
  const wanted = path.split("/")
  const segments = template.split("/")
  return segments.length === wanted.length && segments.every((s, i) => (s.startsWith("{") && s.endsWith("}")) || s === wanted[i])
}

// The reply, or hold, naming the most of the query wins; of two naming as many, the later.
export function pick<T extends { query: Query }>(replies: T[], params: URLSearchParams): T | undefined {
  let found: T | undefined
  for (const reply of replies) {
    if (matches(reply.query, params) && size(reply.query) >= size(found?.query ?? {})) {
      found = reply
    }
  }
  return found
}

const size = (query: Query) => Object.keys(query).length

function matches(query: Query, params: URLSearchParams): boolean {
  return Object.entries(query).every(([name, value]) =>
    Array.isArray(value) ? JSON.stringify(params.getAll(name)) === JSON.stringify(value) : params.get(name) === value,
  )
}

function sameQuery(a: Query, b: Query): boolean {
  return size(a) === size(b) && Object.entries(a).every(([name, value]) => JSON.stringify(b[name]) === JSON.stringify(value))
}

function parseBody(raw: string | null): unknown {
  if (raw === null) {
    return undefined
  }
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}
