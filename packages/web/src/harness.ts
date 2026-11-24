import path from "node:path"
import { type BrowserContext, expect } from "@playwright/test"
import { createBdd, test as base } from "playwright-bdd"
import { Backend } from "./backend.js"
import { type Config, resolve, runtimeScript } from "./config.js"
import { Contract } from "./contract.js"
import { caseTitle } from "./flows.js"
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
  }))
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
      const stands = new Map(backends.map((b) => [b.origin, new Backend(trace, b.check)]))
      await use({ backends: stands, assets, outside: [], trace })
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
        const { trace, outside } = specrigStands
        const stands = specrigStands.backends
        const edges = Object.fromEntries(backends.map((b) => [b.name, stands.get(b.origin)])) as Edges<C>
        Object.assign(edges, { visited: [], trace })
        const app = new URL(baseURL!).origin

        await trace.watch(context, app)
        if (specrigServer) {
          mirror(context, specrigServer)
        }

        await context.route("**/*", async (route) => {
          const url = new URL(route.request().url())
          const stand = stands.get(url.origin)
          if (url.origin === app) {
            if (script && url.pathname === config.runtime?.path) {
              await route.fulfill({ contentType: "application/javascript", body: script })
            } else {
              await route.continue()
            }
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

        await use(edges)

        if (trace.scenario) {
          await trace.settle()
          await testInfo.attach("flows-trace", {
            body: JSON.stringify({ ...trace.scenario, records: trace.records }),
            contentType: "application/json",
          })
        }
        expect(outside, "requests to an origin the harness config does not name").toEqual([])
        for (const b of backends) {
          const stand = stands.get(b.origin)!
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
