import http from "node:http"
import https from "node:https"
import module from "node:module"
import net from "node:net"
import timers from "node:timers"
import { installClock, type ServerClock } from "./server-clock.js"

const control = process.env.SPECRIG_CONTROL
const proxy = process.env.SPECRIG_PROXY
const token = process.env.SPECRIG_TOKEN

type Message = { type: "clock"; id: number; method: string; value?: number }

const loopback = (host: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host) || host.endsWith(".localhost")

function flatHeaders(headers: unknown): Record<string, string> {
  if (Array.isArray(headers)) {
    const flat: Record<string, string> = {}
    for (let i = 0; i + 1 < headers.length; i += 2) {
      flat[String(headers[i])] = String(headers[i + 1])
    }
    return flat
  }
  return Object.fromEntries(
    Object.entries((headers ?? {}) as Record<string, unknown>)
      .filter(([, value]) => value !== undefined)
      .map(([name, value]) => [name, Array.isArray(value) ? value.join(", ") : String(value)]),
  )
}

type Parsed = { url: URL; proxied?: string; options: Record<string, unknown>; callback?: (response: http.IncomingMessage) => void }

function parse(protocol: string, args: unknown[]): Parsed {
  let rest = args
  let url: URL | undefined
  if (typeof rest[0] === "string" || rest[0] instanceof URL) {
    url = new URL(String(rest[0]))
    rest = rest.slice(1)
  }
  let options: Record<string, unknown> = {}
  if (rest[0] && typeof rest[0] === "object") {
    options = rest[0] as Record<string, unknown>
    rest = rest.slice(1)
  }
  const callback = typeof rest[0] === "function" ? (rest[0] as Parsed["callback"]) : undefined
  if (url) {
    return { url, options, callback }
  }
  const host = String(options.hostname ?? options.host ?? "localhost")
  const path = String(options.path ?? "/")
  if (/^https?:\/\//i.test(path)) {
    return { url: new URL(path), proxied: host, options, callback }
  }
  const bracketed = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host
  const port = options.port ? `:${options.port}` : ""
  return { url: new URL(`${options.protocol ?? protocol}//${bracketed}${port}${path}`), options, callback }
}

function start(control: string, proxy: URL, token: string): void {
  const passing = new Set<string>(JSON.parse(process.env.SPECRIG_PASS ?? "[]"))
  const passes = (url: URL) => loopback(url.hostname) || passing.has(url.origin)

  const [host, port] = [control.slice(0, control.lastIndexOf(":")), control.slice(control.lastIndexOf(":") + 1)]
  const socket = net.connect({ host, port: Number(port) })
  socket.unref()
  socket.setEncoding("utf8")
  socket.on("error", () => {})
  const send = (message: object) => socket.write(`${JSON.stringify(message)}\n`)
  send({ type: "hello", token, pid: process.pid })

  let clock: ServerClock | undefined
  let queue = Promise.resolve()
  const tick = async (method: string, value?: number) => {
    if (!clock) {
      const installed = installClock(globalThis)
      clock = installed.clock
      Object.assign(timers, installed.faked)
      module.syncBuiltinESMExports?.()
    }
    switch (method) {
      case "install":
        return clock.install(value)
      case "fastForward":
        return clock.fastForward(value!)
      case "runFor":
        return clock.runFor(value!)
      case "pauseAt":
        return clock.pauseAt(value!)
      case "resume":
        return clock.resume()
      case "setFixedTime":
        return clock.setFixedTime(value!)
      case "setSystemTime":
        return clock.setSystemTime(value!)
      default:
        throw new Error(`the clock has no ${method}`)
    }
  }
  let buffer = ""
  socket.on("data", (chunk: string) => {
    buffer += chunk
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const message = JSON.parse(buffer.slice(0, end)) as Message
      buffer = buffer.slice(end + 1)
      queue = queue.then(() =>
        tick(message.method, message.value).then(
          () => void send({ type: "done", id: message.id }),
          (error: unknown) => void send({ type: "failed", id: message.id, message: String((error as Error)?.message ?? error) }),
        ),
      )
    }
  })

  for (const server of [http.Server, https.Server]) {
    const listen = server.prototype.listen
    server.prototype.listen = function (this: net.Server, ...args: unknown[]) {
      this.once("listening", () => {
        const address = this.address()
        if (address && typeof address === "object") {
          send({ type: "listen", address: address.address, port: address.port })
        }
      })
      return (listen as (...a: unknown[]) => net.Server).apply(this, args)
    } as typeof listen
  }

  const nativeRequest = http.request
  const routed = (protocol: string, original: typeof http.request) =>
    function request(this: unknown, ...args: unknown[]) {
      const pass = () => (original as (...a: unknown[]) => http.ClientRequest).apply(this, args)
      let parsed: Parsed
      try {
        parsed = parse(protocol, args)
      } catch {
        return pass()
      }
      const { url, proxied, options, callback } = parsed
      if (options.socketPath || passes(url) || (proxied !== undefined && loopback(proxied))) {
        return pass()
      }
      const via: http.RequestOptions = {
        method: (options.method as string | undefined) ?? "GET",
        hostname: proxy.hostname,
        port: proxy.port,
        path: `${url.pathname}${url.search}`,
        headers: { ...flatHeaders(options.headers), "x-specrig-target": url.href },
        agent: false,
        timeout: options.timeout as number | undefined,
        signal: options.signal as AbortSignal | undefined,
      }
      return callback ? nativeRequest(via, callback) : nativeRequest(via)
    } as typeof http.request
  const sent = (request: typeof http.request) =>
    function get(this: unknown, ...args: unknown[]) {
      const outgoing = (request as (...a: unknown[]) => http.ClientRequest).apply(this, args)
      outgoing.end()
      return outgoing
    } as typeof http.get
  http.request = routed("http:", http.request)
  http.get = sent(http.request)
  https.request = routed("https:", https.request)
  https.get = sent(https.request)
  module.syncBuiltinESMExports?.()

  const nativeFetch = globalThis.fetch
  if (!nativeFetch) {
    return
  }
  const through = async (request: Request, url: URL): Promise<Response> => {
    const headers = new Headers(request.headers)
    headers.set("x-specrig-target", url.href)
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer()
    const response = await nativeFetch(new URL(`${url.pathname}${url.search}`, proxy), {
      method: request.method,
      headers,
      body,
      signal: request.signal,
      redirect: "manual",
    })
    const location = response.headers.get("location")
    if (request.redirect === "follow" && location && [301, 302, 303, 307, 308].includes(response.status)) {
      const keeps = response.status === 307 || response.status === 308 || request.method === "GET" || request.method === "HEAD"
      return globalThis.fetch(new URL(location, url), {
        method: keeps ? request.method : "GET",
        headers: request.headers,
        body: keeps ? body : undefined,
        signal: request.signal,
      })
    }
    Object.defineProperty(response, "url", { value: url.href })
    return response
  }
  globalThis.fetch = async function fetch(input: string | URL | Request, init?: RequestInit) {
    const request = new Request(input, init)
    const url = new URL(request.url)
    return passes(url) ? nativeFetch(input, init) : through(request, url)
  } as typeof fetch
}

if (control && proxy && token) {
  start(control, new URL(proxy), token)
}
