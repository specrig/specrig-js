import type { Route } from "@playwright/test"
import type { Contract } from "./contract.js"
import type { Trace } from "./trace.js"

export type Query = Record<string, string | string[]>

export type Reply = { query: Query; status: number; body?: unknown }

type Hold = { query: Query; waiting: Route[] }

export type Received = {
  method: string
  path: string
  query: URLSearchParams
  body: unknown
}

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

  reply(method: string, path: string, status: number, body?: unknown): void {
    this.replyTo(method, path, {}, status, body)
  }

  replyTo(method: string, path: string, query: Query, status: number, body?: unknown): void {
    const key = `${method} ${path}`
    const others = (this.replies.get(key) ?? []).filter((r) => !sameQuery(r.query, query))
    this.replies.set(key, [...others, { query, status, body }])
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
    return this.received.filter((r) => r.method === method && r.path === path)
  }

  async answer(route: Route): Promise<void> {
    const request = route.request()
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: cors })
      return
    }

    const url = new URL(request.url())
    const body = parseBody(request.postData())
    const key = `${request.method()} ${url.pathname}`
    this.received.push({ method: request.method(), path: url.pathname, query: url.searchParams, body })
    this.trace.sent(this.contract?.name(request.method(), url.pathname) ?? key, body)
    this.violations.push(...(this.contract?.request(request.method(), url.pathname, body) ?? []))

    const hold = pick(this.holds.get(key) ?? [], url.searchParams)
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
    const reply = pick(this.replies.get(key) ?? [], url.searchParams)
    if (!reply) {
      this.unanswered.push(`${key}${url.search}`)
      await route.fulfill({ status: 501, headers: cors, json: { code: "unanswered", message: key } })
      return
    }
    this.violations.push(...(this.contract?.response(request.method(), url.pathname, reply.status, reply.body ?? {}) ?? []))
    if (reply.status === 204) {
      await route.fulfill({ status: 204, headers: cors })
      return
    }
    await route.fulfill({ status: reply.status, headers: cors, json: reply.body ?? {} })
  }
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
