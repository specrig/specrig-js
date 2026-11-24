import { readFileSync } from "node:fs"
import http from "node:http"
import https from "node:https"

const api = process.env.API_URL
const port = process.env.SSR_PORT === "env" ? Number(process.env.PORT) : 0
let fired = false

function viaHttp(url) {
  return new Promise((done, fail) => {
    const client = url.startsWith("https:") ? https : http
    client
      .get(url, (response) => {
        let body = ""
        response.on("data", (chunk) => {
          body += chunk
        })
        response.on("end", () => done(JSON.parse(body)))
      })
      .on("error", fail)
  })
}

function viaProxy(url) {
  const proxy = new URL(process.env.HTTPS_PROXY)
  return new Promise((done, fail) => {
    http
      .get({ hostname: proxy.hostname, port: proxy.port, path: url, headers: { host: new URL(url).host } }, (response) => {
        let body = ""
        response.on("data", (chunk) => {
          body += chunk
        })
        response.on("end", () => done(JSON.parse(body)))
      })
      .on("error", fail)
  })
}

const list = (items) => `<ul>${items.map((item) => `<li>${item.name}</li>`).join("")}</ul>`

const pages = {
  "/": async () => list(await (await fetch(`${api}/items`)).json()),
  "/http": async () => list(await viaHttp(`${api}/items`)),
  "/proxied": async () => list(await viaProxy(`${api}/items`)),
  "/note": async () => `<p>${await (await fetch(`${api}/note`)).text()}</p>`,
  "/live": async () => {
    const upgrade = { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" }
    await new Promise((done) => http.get(`${api}/live`, { headers: upgrade }).on("upgrade", done).on("error", done).on("response", done))
    return "<p>tried</p>"
  },
  "/elsewhere": async () => {
    await fetch("https://elsewhere.example/x").catch(() => {})
    return "<p>done</p>"
  },
  "/crash": async () => {
    setImmediate(() => {
      throw new Error("the server crashed")
    })
    return "<p>bye</p>"
  },
  "/arm": async () => {
    setTimeout(() => {
      fired = true
    }, 10_000)
    return "<p>armed</p>"
  },
  "/state": async () => `<p>${fired ? "fired" : "waiting"}</p>`,
  "/today": async () => `<time>${new Date().toISOString().slice(0, 10)}</time>`,
  "/built": async () => `<p>${readFileSync(process.env.BUILD_OUT, "utf8")}</p>`,
}

http
  .createServer(async (request, response) => {
    const page = pages[new URL(request.url, "http://app").pathname]
    try {
      const body = page ? await page() : "<p>not found</p>"
      response.writeHead(page ? 200 : 404, { "content-type": "text/html" })
      response.end(`<!doctype html><title>shop</title>${body}`)
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain" })
      response.end(String(error))
    }
  })
  .listen(port, "127.0.0.1")
