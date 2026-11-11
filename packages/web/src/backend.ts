import type { Route } from "@playwright/test"
import type { Contract } from "./contract.js"
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

type Hold = { query: Query; waiting: Route[] }

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE",
  "access-control-allow-headers": "content-type, authorization",
}

export class Backend {
  private replies = new Map<string, Reply[]>()
  private holds = new Map<string, Hold[]>()
  readonly received: Received[] = []
  readonly unanswered: string[] = []
  readonly violations: string[] = []

  constructor(
    private readonly trace: Trace,
    private readonly contract?: Contract,
  ) {}

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
    const key = `${method} ${path}`
    const others = (this.replies.get(key) ?? []).filter((r) => !sameQuery(r.query, reply.query))
    this.replies.set(key, [...others, reply])
  }

  // The requests the query takes wait until a step releases them: what the app shows while
  // it waits, which of two answers it takes first, and that it gives up on one in time.
  hold(method: string, path: string, query: Query = {}): void {
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
    for (const route of hold.waiting) {
      this.trace.released(route.request())
      // The app may have given up on it: there is no one left to answer.
      await this.fulfill(route).catch(() => {})
    }
  }

  get unreleased(): string[] {
    return [...this.holds.values()]
      .flat()
      .flatMap((h) => h.waiting)
      .filter((route) => route.request().failure() === null)
      .map((route) => {
        const url = new URL(route.request().url())
        return `${route.request().method()} ${url.pathname}${url.search}`
      })
  }

  requests(method: string, path: string): Received[] {
    return this.received.filter((r) => r.method === method && takes(path, r.path))
  }

  async answer(route: Route): Promise<void> {
    const request = route.request()
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: cors })
      return
    }

    const url = new URL(request.url())
    const got = received(route)
    const key = `${request.method()} ${url.pathname}`
    this.received.push(got)
    this.trace.sent(this.contract?.name(request.method(), url.pathname) ?? key, got.body)
    this.violations.push(...(this.contract?.request(request.method(), url.pathname, got.body) ?? []))

    const hold = pick(declared(this.holds, request.method(), url.pathname), url.searchParams)
    if (hold) {
      hold.waiting.push(route)
      this.trace.held(request)
      return
    }
    await this.fulfill(route)
  }

  private async fulfill(route: Route): Promise<void> {
    const request = route.request()
    const url = new URL(request.url())
    const key = `${request.method()} ${url.pathname}`
    const reply = pick(declared(this.replies, request.method(), url.pathname), url.searchParams)
    if (!reply) {
      this.unanswered.push(`${key}${url.search}`)
      await route.fulfill({ status: 501, headers: cors, json: { code: "unanswered", message: key } })
      return
    }
    const [status, body] = reply.answer(received(route))
    this.violations.push(...(this.contract?.response(request.method(), url.pathname, status, body ?? {}) ?? []))
    const headers = { ...cors, ...reply.headers }
    if (status === 204) {
      await route.fulfill({ status: 204, headers })
      return
    }
    await route.fulfill({ status, headers, json: body ?? {} })
  }
}

function received(route: Route): Received {
  const request = route.request()
  const url = new URL(request.url())
  return { method: request.method(), path: url.pathname, query: url.searchParams, body: parseBody(request.postData()) }
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
