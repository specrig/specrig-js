import path from "node:path"
import { expect } from "@playwright/test"
import { createBdd, test as base } from "playwright-bdd"
import { Backend } from "./backend.js"
import { type Config, resolve, runtimeScript } from "./config.js"
import { Contract } from "./contract.js"
import { Trace } from "./trace.js"

export type Edges<C extends Config> = { [K in keyof C["backends"]]: Backend } & { visited: URL[]; trace: Trace }

export function harness<const C extends Config>(config: C) {
  const backends = Object.entries(config.backends).map(([name, edge]) => ({
    name,
    origin: edge.origin,
    contract: edge.contract,
    check: edge.contract ? new Contract(resolve(config, edge.contract), name, edge.failure) : undefined,
  }))
  const pages = new Set(Object.values(config.pages ?? {}).map((page) => page.origin))
  const assets = new Set(Object.values(config.assets ?? {}).map((asset) => asset.origin))
  const script = runtimeScript(config)
  const features = resolve(config, config.features ?? "tests/feature")

  const test = base.extend<{ edges: Edges<C> }>({
    edges: [
      async ({ context, baseURL }, use, testInfo) => {
        const trace = new Trace()
        const stands = new Map(backends.map((b) => [b.origin, new Backend(trace, b.check)]))
        const edges = Object.fromEntries(backends.map((b) => [b.name, stands.get(b.origin)])) as Edges<C>
        Object.assign(edges, { visited: [], trace })
        const outside: string[] = []
        const app = new URL(baseURL!).origin

        await trace.watch(context)

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
    const last = titles[titles.length - 1]
    edges.trace.scenario ??= {
      feature: path.relative(features, path.resolve(path.dirname(playwright.configFile!), $bddContext.featureUri)),
      scenario: /^Example #\d+$/.test(last) ? titles[titles.length - 2] : last,
    }
    const type = $bddContext.bddTestData.steps[$bddContext.stepIndex]?.keywordType ?? ""
    if (type !== "Outcome") {
      await edges.trace.settle()
    }
    edges.trace.act(type, $bddContext.step.title)
  })

  return { test }
}
