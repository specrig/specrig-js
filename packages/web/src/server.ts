import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import http from "node:http"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { Backend } from "./backend.js"
import { buildEnv, type Config, type ServerConfig, serverEnv } from "./config.js"
import { layout } from "./layout.js"
import type { Trace } from "./trace.js"

export type Stands = {
  byName: Map<string, Backend>
  owner: (url: URL, method: string) => Backend | "unserved" | undefined
  assets: Map<string, boolean | undefined>
  outside: string[]
  trace: Trace
}

const here = path.dirname(fileURLToPath(import.meta.url))
// Run from the sources, as this package's own tests are, the preload is the built one.
const preload = [path.join(here, "preload.js"), path.join(here, "..", "dist", "preload.js")].find((file) => existsSync(file))

const loopback = (host: string) => ["localhost", "127.0.0.1", "[::1]", "::1"].includes(host) || host.endsWith(".localhost")

const kept = 64 * 1024

class Output {
  private text = ""

  add(chunk: Buffer): void {
    this.text = (this.text + chunk.toString("utf8")).slice(-kept)
  }

  tail(lines = 40): string {
    return this.text.split("\n").slice(-lines).join("\n").trim()
  }

  toString(): string {
    return this.text
  }
}

function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((done, fail) => {
    const chunks: Buffer[] = []
    stream.on("data", (chunk: Buffer) => chunks.push(chunk))
    stream.on("end", () => done(Buffer.concat(chunks)))
    stream.on("error", fail)
  })
}

const listening = (server: net.Server) =>
  new Promise<number>((done) => server.listen(0, "127.0.0.1", () => done((server.address() as net.AddressInfo).port)))

async function freePort(): Promise<number> {
  const probe = net.createServer()
  const port = await listening(probe)
  await new Promise((done) => probe.close(done))
  return port
}

const hopByHop = ["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "x-specrig-target", "host", "content-length"]

async function forward(request: http.IncomingMessage, url: URL, body: Buffer, response: http.ServerResponse): Promise<void> {
  const headers = Object.fromEntries(
    Object.entries(request.headers).flatMap(([name, value]) => (hopByHop.includes(name) || value === undefined ? [] : [[name, String(value)]])),
  )
  try {
    const answer = await fetch(url, { method: request.method, headers, body: body.length > 0 ? new Uint8Array(body) : undefined, redirect: "manual" })
    const back = Object.fromEntries([...answer.headers].filter(([name]) => !["content-encoding", "content-length", "transfer-encoding"].includes(name)))
    response.writeHead(answer.status, back)
    response.end(Buffer.from(await answer.arrayBuffer()))
  } catch {
    response.writeHead(502).end()
  }
}

function proxyServer(stands: Stands): http.Server {
  const tunnels = new WeakSet<net.Socket>()
  const server = http.createServer(async (request, response) => {
    const tunneled = tunnels.has(request.socket) && request.headers.host ? `http://${request.headers.host}${request.url}` : undefined
    const raw = request.headers["x-specrig-target"] ?? (/^https?:\/\//.test(request.url ?? "") ? request.url : tunneled)
    if (typeof raw !== "string") {
      response.writeHead(400).end("specrig: a request that names no origin")
      return
    }
    const url = new URL(raw)
    const body = await collect(request)
    const stand = stands.owner(url, request.method ?? "GET")
    if (stand === "unserved") {
      stands.outside.push(`${request.method} ${url.href} (from the app's server: no backend on ${url.origin} takes it)`)
      response.writeHead(502).end()
      return
    }
    if (stand) {
      const ticket = {}
      let gaveUp = false
      stands.trace.serverStarted(ticket)
      response.on("close", () => {
        gaveUp = !response.writableFinished
        stands.trace.serverFinished(ticket)
      })
      await stand.take({
        method: request.method ?? "GET",
        url,
        body: body.length > 0 ? body.toString("utf8") : null,
        ticket,
        gaveUp: () => gaveUp,
        fulfill: async ({ status, headers, json, body }) => {
          if (response.destroyed) {
            return
          }
          response.writeHead(status, json === undefined ? headers : { "content-type": "application/json", ...headers })
          response.end(body ?? (json === undefined ? undefined : JSON.stringify(json)))
        },
      })
      return
    }
    if (loopback(url.hostname) || stands.assets.get(url.origin)) {
      await forward(request, url, body, response)
      return
    }
    if (stands.assets.has(url.origin)) {
      response.writeHead(204).end()
      return
    }
    stands.outside.push(`${request.method} ${url.href} (from the app's server)`)
    response.writeHead(502).end()
  })
  server.on("upgrade", (request: http.IncomingMessage, socket: net.Socket) => {
    const target = request.headers["x-specrig-target"] ?? request.url
    stands.outside.push(`WS ${target} (from the app's server: a socket the server opens is not stood in for)`)
    socket.destroy()
  })
  server.on("connect", (request: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    if (request.url?.endsWith(":443")) {
      stands.outside.push(
        `CONNECT ${request.url} (from the app's server, through its proxy: a stand-in reached that way needs an http:// origin)`,
      )
      socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n")
      return
    }
    // Node 24's own clients tunnel plain HTTP through a proxy too: what comes through is served as any request.
    tunnels.add(socket)
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
    if (head.length > 0) {
      socket.unshift(head)
    }
    server.emit("connection", socket)
  })
  return server
}

type Reply = { type: "done" | "failed"; id: number; message?: string }

class Control {
  readonly server = net.createServer((socket) => this.accept(socket))
  private readonly waiting = new Map<net.Socket, Map<number, (reply: Reply | undefined) => void>>()
  private ids = 0
  private heard?: (address: { address: string; port: number }) => void
  readonly listened = new Promise<{ address: string; port: number }>((done) => {
    this.heard = done
  })

  constructor(private readonly token: string) {}

  private accept(socket: net.Socket): void {
    socket.setEncoding("utf8")
    let buffer = ""
    socket.on("data", (chunk: string) => {
      buffer += chunk
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const message = JSON.parse(buffer.slice(0, end))
        buffer = buffer.slice(end + 1)
        if (message.type === "hello") {
          if (message.token !== this.token) {
            socket.destroy()
            return
          }
          this.waiting.set(socket, new Map())
        } else if (!this.waiting.has(socket)) {
          socket.destroy()
          return
        } else if (message.type === "listen") {
          this.heard?.({ address: message.address, port: message.port })
        } else {
          this.waiting.get(socket)?.get(message.id)?.(message)
        }
      }
    })
    socket.on("error", () => {})
    socket.on("close", () => {
      for (const settle of this.waiting.get(socket)?.values() ?? []) {
        settle(undefined)
      }
      this.waiting.delete(socket)
    })
  }

  async command(method: string, value: number | undefined): Promise<void> {
    const id = ++this.ids
    const replies = [...this.waiting].map(
      ([socket, pending]) =>
        new Promise<Reply | undefined>((done) => {
          pending.set(id, (reply) => {
            pending.delete(id)
            done(reply)
          })
          socket.write(`${JSON.stringify({ type: "clock", id, method, value })}\n`)
        }),
    )
    const failed = (await Promise.all(replies)).find((reply) => reply?.type === "failed")
    if (failed) {
      throw new Error(`the clock of the app's server: ${failed.message}`)
    }
  }

  close(): void {
    for (const socket of this.waiting.keys()) {
      socket.destroy()
    }
    this.server.close()
  }
}

const hostOf = (address: string) =>
  address === "" || address === "0.0.0.0" || address === "::" ? "127.0.0.1" : address.includes(":") ? `[${address}]` : address

function connects(host: string, port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = net.connect({ host, port })
    socket.once("connect", () => {
      socket.destroy()
      done(true)
    })
    socket.once("error", () => done(false))
  })
}

async function polled(port: number, gone: () => boolean): Promise<{ address: string; port: number }> {
  for (;;) {
    for (const address of ["127.0.0.1", "::1"]) {
      if (await connects(address, port)) {
        return { address, port }
      }
    }
    if (gone()) {
      return new Promise(() => {})
    }
    await new Promise((done) => setTimeout(done, 50))
  }
}

const later = (ms: number) => new Promise<"late">((done) => setTimeout(() => done("late"), ms).unref())

function signal(child: ChildProcess, name: NodeJS.Signals): void {
  try {
    if (process.platform === "win32" || child.pid === undefined) {
      child.kill(name)
    } else {
      process.kill(-child.pid, name)
    }
  } catch {
    // It is gone already.
  }
}

export class AppServer {
  private ended?: string

  private constructor(
    readonly url: string,
    private readonly child: ChildProcess,
    private readonly output: Output,
    private readonly exited: Promise<string>,
    private readonly proxy: http.Server,
    private readonly control: Control,
  ) {
    void exited.then((how) => {
      this.ended = how
    })
  }

  static async start(config: Config, stands: Stands): Promise<AppServer> {
    const server = config.server as ServerConfig
    const token = randomUUID()
    const control = new Control(token)
    const proxy = proxyServer(stands)
    const proxyUrl = `http://127.0.0.1:${await listening(proxy)}`
    const controlAddress = `127.0.0.1:${await listening(control.server)}`
    const withPreload = server.preload !== false
    if (withPreload && !preload) {
      throw new Error("@specrig/web is not built: there is no preload to start the app's server with")
    }
    const env: Record<string, string | undefined> = {
      ...process.env,
      PORT: String(await freePort()),
      ...serverEnv(config),
      SPECRIG_CONTROL: controlAddress,
      SPECRIG_PROXY: proxyUrl,
      SPECRIG_TOKEN: token,
      SPECRIG_PASS: JSON.stringify([...stands.assets].filter(([, live]) => live).map(([origin]) => origin)),
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
      NO_PROXY: "localhost,127.0.0.1,::1",
      no_proxy: "localhost,127.0.0.1,::1",
      NODE_USE_ENV_PROXY: "1",
      NO_UPDATE_NOTIFIER: "1",
      npm_config_update_notifier: "false",
    }
    if (withPreload) {
      env.NODE_OPTIONS = [process.env.NODE_OPTIONS, `--import=${pathToFileURL(preload!).href}`].filter(Boolean).join(" ")
      env.BUN_OPTIONS = [process.env.BUN_OPTIONS, `--preload=${preload}`].filter(Boolean).join(" ")
    }
    const output = new Output()
    const child = spawn(server.command, {
      cwd: config.root,
      env,
      shell: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    })
    child.stdout?.on("data", (chunk: Buffer) => output.add(chunk))
    child.stderr?.on("data", (chunk: Buffer) => output.add(chunk))
    const exited = new Promise<string>((done) =>
      child.once("exit", (code, how) => done(code !== null ? `exited with code ${code}` : `was ended by ${how}`)),
    )
    let gone = false
    void exited.then(() => {
      gone = true
    })
    // Without the preload nothing says where the server listens: where it was told to, by server.port or PORT.
    const told = server.port ?? (withPreload ? undefined : Number(env.PORT))
    const ready = told !== undefined ? polled(told, () => gone) : control.listened
    const first = await Promise.race([ready, exited, later(server.timeout ?? 30_000)])
    if (typeof first === "string") {
      signal(child, "SIGKILL")
      proxy.close()
      control.close()
      const why = first === "late" ? `did not listen within ${(server.timeout ?? 30_000) / 1000}s` : first
      throw new Error(`the app's server, \`${server.command}\`, ${why}\n${output.tail()}`)
    }
    return new AppServer(`http://${hostOf(first.address)}:${first.port}`, child, output, exited, proxy, control)
  }

  get log(): string {
    return this.output.toString()
  }

  async clock(method: string, value: number | undefined): Promise<void> {
    if (!this.ended) {
      await this.control.command(method, value)
    }
  }

  async stop(): Promise<string | undefined> {
    const ended = this.ended
    if (!ended) {
      signal(this.child, "SIGTERM")
      if ((await Promise.race([this.exited, later(3000)])) === "late") {
        signal(this.child, "SIGKILL")
        await Promise.race([this.exited, later(3000)])
      }
    }
    this.proxy.closeAllConnections()
    this.proxy.close()
    this.control.close()
    return ended && `the app's server ${ended} during the test\n${this.output.tail()}`
  }
}

const run = () => process.env.SPECRIG_RUN ?? `pid-${process.ppid}`

async function building(command: string, config: Config): Promise<string | undefined> {
  const output = new Output()
  const child = spawn(command, { cwd: config.root, env: { ...process.env, ...buildEnv(config) }, shell: true, stdio: ["ignore", "pipe", "pipe"] })
  child.stdout?.on("data", (chunk: Buffer) => output.add(chunk))
  child.stderr?.on("data", (chunk: Buffer) => output.add(chunk))
  const code = await new Promise<number | null>((done) => child.once("exit", done))
  return code === 0 ? undefined : `the build, \`${command}\`, exited with code ${code}\n${output.tail()}`
}

function inputs(command: string, config: Config): string | undefined {
  const tests = layout.tests.map((dir) => `:(exclude)${dir}`)
  const listed = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ".", ...tests], { cwd: config.root })
  if (listed.status !== 0) {
    return undefined
  }
  const key = createHash("sha256").update(command).update("\0").update(JSON.stringify(buildEnv(config)))
  const files = [...new Set(listed.stdout.toString("utf8").split("\0").filter(Boolean))].sort()
  for (const file of files) {
    key.update("\0").update(file).update("\0")
    try {
      key.update(readFileSync(path.join(config.root, file)))
    } catch {
      key.update("\0gone")
    }
  }
  return key.digest("hex")
}

async function rebuilt(command: string, config: Config, dir: string): Promise<string | undefined> {
  const key = inputs(command, config)
  const last = path.join(dir, "last")
  if (key && !process.env.SPECRIG_REBUILD && existsSync(last) && readFileSync(last, "utf8") === key) {
    return undefined
  }
  rmSync(last, { force: true })
  const failure = await building(command, config)
  if (!failure && key) {
    writeFileSync(last, key)
  }
  return failure
}

export async function built(config: Config): Promise<void> {
  const command = config.server?.build
  if (!command) {
    return
  }
  const dir = path.join(os.tmpdir(), "specrig", createHash("sha256").update(config.root).digest("hex").slice(0, 16))
  mkdirSync(dir, { recursive: true })
  const done = path.join(dir, `${run()}.done`)
  try {
    mkdirSync(path.join(dir, `${run()}.lock`))
    const written = `${done}.${process.pid}`
    writeFileSync(written, (await rebuilt(command, config, dir)) ?? "")
    renameSync(written, done)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error
    }
    while (!existsSync(done)) {
      await new Promise((wait) => setTimeout(wait, 200))
    }
  }
  const failure = readFileSync(done, "utf8")
  if (failure) {
    throw new Error(failure)
  }
}
