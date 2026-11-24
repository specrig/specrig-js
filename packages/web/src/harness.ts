import path from "node:path"
import { type BrowserContext, expect } from "@playwright/test"
import { createBdd, test as base } from "playwright-bdd"
import { Backend } from "./backend.js"
import { type Config, resolve, runtimeScript } from "./config.js"
import { Contract } from "./contract.js"
import { caseTitle } from "./flows.js"
import { overlap, type Route, route, spell, takes } from "./routes.js"
import { AppServer, built, type Stands } from "./server.js"
import { Trace } from "./trace.js"

export type Edges<C extends Config> = { [K in keyof C["backends"]]: Backend } & { visited: URL[]; trace: Trace }

type Time = number | string | Date

const times = (time: Time) => {
  const ms = typeof time === "number" ? time : typeof time === "string" ? Date.parse(time) : time.getTime()
  if (!Number.isFinite(ms)) {
    throw new Error(`Invalid date: ${time}`)
  }
  return ms
}

// Ticks as page.clock takes them: a number of milliseconds, or "ss", "mm:ss" or "hh:mm:ss".
const ticks = (value: number | string) => {
  if (typeof value === "number") {
    return value
  }
  const parts = value.split(":").map(Number)
  if (parts.length > 3 || parts.some((part) => !Number.isFinite(part))) {
    throw new Error(`Invalid ticks: ${value}`)
  }
  return parts.reduce((total, part) => total * 60 + part, 0) * 1000
}

const clockArgument: Record<string, (argument: unknown) => number | undefined> = {
  install: (options) => {
    const time = (options as { time?: Time } | undefined)?.time
    return time === undefined ? undefined : times(time)
  },
  fastForward: (value) => ticks(value as number | string),
  runFor: (value) => ticks(value as number | string),
  pauseAt: (time) => times(time as Time),
  resume: () => undefined,
  setFixedTime: (time) => times(time as Time),
  setSystemTime: (time) => times(time as Time),
}

function mirror(context: BrowserContext, server: AppServer): void {
  const clock = context.clock as unknown as Record<string, (...args: unknown[]) => Promise<void>>
  for (const [method, argument] of Object.entries(clockArgument)) {
    const page = clock[method].bind(clock)
    clock[method] = async (...args: unknown[]) => {
      await page(...args)
      await server.clock(method, argument(args[0]))
    }
  }
}

export function harness<const C extends Config>(config: C) {
  const backends = Object.entries(config.backends).map(([name, edge]) => ({
    name,
    origin: edge.origin,
    contract: edge.contract,
    check: edge.contract ? new Contract(resolve(config, edge.contract), name, edge.failure) : undefined,
    declared: (edge.routes ?? []).map(route),
  }))
  const byOrigin = new Map<string, typeof backends>()
  for (const b of backends) {
    byOrigin.set(b.origin, [...(byOrigin.get(b.origin) ?? []), b])
  }
  const routesOf = new Map<string, Route[]>()
  for (const [origin, group] of byOrigin) {
    if (group.length === 1) {
      continue
    }
    for (const b of group) {
      const routes = [...(b.check?.routes() ?? []), ...b.declared]
      if (routes.length === 0) {
        throw new Error(`harness config: ${b.name} shares ${origin} with others and names no routes; give it a contract or routes`)
      }
      routesOf.set(b.name, routes)
    }
    const clashes = group.flatMap((a, i) =>
      group
        .slice(i + 1)
        .flatMap((b) => routesOf.get(a.name)!.flatMap((ra) => routesOf.get(b.name)!.filter((rb) => overlap(ra, rb)).map((rb) => `${a.name}'s ${spell(ra)} and ${b.name}'s ${spell(rb)}`))),
    )
    if (clashes.length > 0) {
      throw new Error(`harness config: on ${origin} one request could be taken by ${clashes.join("; by ")}`)
    }
  }
  const pages = new Set(Object.values(config.pages ?? {}).map((page) => page.origin))
  const assets = new Map(Object.values(config.assets ?? {}).map((asset) => [asset.origin, asset.live]))
  const script = runtimeScript(config)
  const features = resolve(config, config.features ?? "tests/feature")

  // The first test of a run may wait for the build, which no test's own timeout is meant to cover.
  const starting = (config.server?.timeout ?? 30_000) + 10_000 + (config.server?.build ? 30 * 60_000 : 0)
  type Fixtures = { edges: Edges<C>; specrigStands: Stands; specrigServer: AppServer | undefined }
  const test = base.extend<Fixtures>({
    specrigStands: async ({}, use) => {
      const trace = new Trace()
      const byName = new Map(
        backends.map((b) => {
          const routes = routesOf.get(b.name)
          return [b.name, new Backend(trace, b.check, routes && { name: b.name, routes })]
        }),
      )
      const owner = (url: URL, method: string): Backend | "unserved" | undefined => {
        const group = byOrigin.get(url.origin)
        if (!group) {
          return undefined
        }
        // A preflight names no route of its own: any backend of the origin answers it.
        if (group.length === 1 || method === "OPTIONS") {
          return byName.get(group[0].name)
        }
        const taker = group.find((b) => routesOf.get(b.name)!.some((r) => takes(r, method, url.pathname)))
        return taker ? byName.get(taker.name) : "unserved"
      }
      config.boot?.(Object.fromEntries(byName))
      await use({ byName, owner, assets, outside: [], trace })
    },
    specrigServer: [
      async ({ specrigStands }, use, testInfo) => {
        if (!config.server) {
          await use(undefined)
          return
        }
        await built(config)
        const server = await AppServer.start(config, specrigStands)
        await use(server)
        const ended = await server.stop()
        if (testInfo.status !== testInfo.expectedStatus || ended) {
          await testInfo.attach("app-server.log", { body: server.log, contentType: "text/plain" })
        }
        expect(ended, "the app's server is to outlive the test").toBeUndefined()
      },
      { timeout: starting },
    ],
    baseURL: async ({ baseURL, specrigServer }, use) => {
      await use(specrigServer?.url ?? baseURL)
    },
    edges: [
      async ({ context, baseURL, specrigStands, specrigServer }, use, testInfo) => {
        const { trace, outside, owner, byName } = specrigStands
        const edges = Object.fromEntries(byName) as Edges<C>
        Object.assign(edges, { visited: [], trace })
        const app = new URL(baseURL!).origin

        await trace.watch(context, app)
        if (specrigServer) {
          mirror(context, specrigServer)
        }

        await context.route("**/*", async (route) => {
          const url = new URL(route.request().url())
          const stand = owner(url, route.request().method())
          if (url.origin === app) {
            if (script && url.pathname === config.runtime?.path) {
              await route.fulfill({ contentType: "application/javascript", body: script })
            } else {
              await route.continue()
            }
          } else if (stand === "unserved") {
            outside.push(`${route.request().method()} ${url.href} (no backend on ${url.origin} takes it)`)
            await route.abort()
          } else if (stand) {
            await stand.answer(route)
          } else if (pages.has(url.origin)) {
            edges.visited.push(url)
            await route.fulfill({ contentType: "text/html", body: "<!doctype html><title>stand-in</title>" })
          } else if (assets.get(url.origin)) {
            await route.continue()
          } else if (assets.has(url.origin)) {
            await route.fulfill({ status: 204 })
          } else {
            outside.push(`${route.request().method()} ${url.href}`)
            await route.abort()
          }
        })

        await context.routeWebSocket(/.*/, async (ws) => {
          const url = new URL(ws.url())
          const asHttp = new URL(url.href.replace(/^ws/, "http"))
          const origin = asHttp.origin
          const stand = owner(asHttp, "WS")
          if (origin === app || assets.get(origin)) {
            ws.connectToServer()
          } else if (stand && stand !== "unserved") {
            stand.connect({
              url,
              send: (text) => ws.send(text),
              close: () => void ws.close(),
              onMessage: (handler) => ws.onMessage((message) => handler(message.toString())),
              onClose: (handler) => ws.onClose(() => handler()),
            })
          } else {
            outside.push(`WS ${url.href}${stand === "unserved" ? ` (no backend on ${origin} takes it)` : ""}`)
            await ws.close()
          }
        })

        await use(edges)

        if (trace.scenario) {
          await trace.settle()
          await testInfo.attach("flows-trace", {
            body: JSON.stringify({ ...trace.scenario, records: trace.records }),
            contentType: "application/json",
          })
        }
        expect(outside, "requests no backend of the harness config takes").toEqual([])
        for (const b of backends) {
          const stand = byName.get(b.name)!
          expect(stand.unanswered, `${b.name} calls no step declared`).toEqual([])
          expect(stand.unreleased, `${b.name} answers a step held and none released`).toEqual([])
          expect(stand.violations, `what ${b.name}'s contract, ${b.contract}, does not allow`).toEqual([])
        }
      },
      { auto: true },
    ],
  })

  const { BeforeStep } = createBdd(test)
  BeforeStep(async ({ $bddContext, edges }) => {
    const { titlePath: titles, config: playwright } = $bddContext.testInfo
    const file = path.resolve(path.dirname(playwright.configFile!), $bddContext.featureUri)
    edges.trace.scenario ??= {
      feature: path.relative(features, file),
      scenario: caseTitle(file, $bddContext.bddTestData.pickleLine) ?? titles[titles.length - 1],
    }
    const type = $bddContext.bddTestData.steps[$bddContext.stepIndex]?.keywordType ?? ""
    if (type !== "Outcome") {
      await edges.trace.settle()
    }
    edges.trace.act(type, $bddContext.step.title)
  })

  return { test }
}
