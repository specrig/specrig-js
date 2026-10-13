import type { Route } from "@playwright/test"
import type { Contract } from "./contract.js"
import type { Trace } from "./trace.js"

export type Query = Record<string, string | string[]>

export type Reply = { query: Query; status: number; body?: unknown }

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

// The reply naming the most of the query wins; of two naming as many, the later.
export function pick(replies: Reply[], params: URLSearchParams): Reply | undefined {
  let found: Reply | undefined
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
