import { areaRows, modeRows, render } from "./agents.js"
import { layout } from "./layout.js"
import type { Area } from "./modes.js"

type Pointer = { field?: string; env?: string }

export type Plan = {
  service: string
  playwright: string
  adapter: string
  serving: string
  backends: ({ name: string; origin: string; contract?: string; failure?: string } & Pointer)[]
  pages: ({ name: string; origin: string } & Pointer)[]
  runtime?: string[]
  build: string[]
}

const quoted = (value: string) => JSON.stringify(value)

function constants(names: string[]): string {
  return names.length === 0 ? "{}" : `{ ${names.map((name) => `${name}: ""`).join(", ")} }`
}

function pointer(edge: Pointer): string[] {
  return edge.field ? [`field: ${quoted(edge.field)}`] : edge.env ? [`env: ${quoted(edge.env)}`] : []
}

export function harnessConfig(plan: Plan): string {
  const backends = plan.backends.map((b) => {
    const lines = [`origin: ${quoted(b.origin)}`, ...pointer(b)]
    if (b.contract) lines.push(`contract: ${quoted(b.contract)}`)
    if (b.failure) lines.push(`failure: ${quoted(b.failure)}`)
    return [`    ${b.name}: {`, ...lines.map((line) => `      ${line},`), "    },"].join("\n")
  })
  const out = [
    'import { defineConfig } from "@specrig/web"',
    "",
    "// Every origin a scenario stands in for; a request to any other fails the test.",
    "export default defineConfig({",
    "  root: import.meta.dirname,",
    `  service: ${quoted(plan.service)},`,
  ]
  if (plan.runtime) {
    out.push(
      "  runtime: {",
      '    path: "/config.js",',
      '    global: "__CONFIG__",',
      `    constants: ${constants(plan.runtime)},`,
      "  },",
    )
  }
  if (plan.build.length > 0) {
    out.push(`  build: { constants: ${constants(plan.build)} },`)
  }
  out.push("  backends: {", ...backends, "  },")
  if (plan.pages.length > 0) {
    const pages = plan.pages.map((p) => `    ${p.name}: { ${[`origin: ${quoted(p.origin)}`, ...pointer(p)].join(", ")} },`)
    out.push("  pages: {", ...pages, "  },")
  }
  out.push('  surface: { client: "HttpClient" },', "})", "")
  return out.join("\n")
}

export function playwrightConfig(plan: Plan): string {
  return `import { webServer } from "${plan.adapter}/playwright"
import { defineConfig, devices } from "@playwright/test"
import { defineBddConfig } from "playwright-bdd"
import harness from "./harness.config"

const features = defineBddConfig({
  features: "tests/feature/**/*.feature",
  steps: ["tests/internal/harness.ts", "tests/steps/**/*.ts"],
  missingSteps: "fail-on-gen",
})
const server = webServer(harness)

export default defineConfig({
  forbidOnly: true,
  reporter: [["list"], ["@specrig/web/reporter", { service: ${quoted(plan.service)} }]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: server.url,
  },
  projects: [
    { name: "harness", testDir: "tests/internal", testMatch: "*.spec.ts" },
    { name: "feature", testDir: features, dependencies: ["harness"] },
  ],
  webServer: server,
})
`
}

export const harnessTs = `import { type Edges as EdgesOf, harness } from "@specrig/web"
import config from "../../harness.config"

export const { test } = harness(config)

export type Edges = EdgesOf<typeof config>
export type { Received } from "@specrig/web"
`

export function checksSpec(plan: Plan): string {
  return `import { checks } from "${plan.adapter}/playwright"
import config from "../../harness.config"

checks(config)
`
}

export const bootSpec = `import { expect } from "@playwright/test"
import { test } from "./harness"

// The answers an empty app needs are declared here; a call none answers fails the test and is named.
test("the app boots", async ({ page }) => {
  await page.goto("/")

  await expect(page.locator("body")).not.toBeEmpty()
})
`

export const bddTs = `import { createBdd } from "playwright-bdd"
import { test } from "../internal/harness"

export const { Given, When, Then } = createBdd(test)
`

export const specrigYaml = "guard: [npx, --no, specrig]\n"

const listing = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`)

const suite = "`npx --no bddgen && npx --no playwright test`"

export function specrigMd(areas: Area[], serving: string, version: string): string {
  const slots: Record<string, string> = {
    what: "app",
    writer: "`npx --no specrig agents`",
    version: `\`@specrig/web\` ${version}`,
    cut: "`harness.config.ts`",
    validate: suite,
    boundary:
      "What `harness.config.ts` stands in for — every origin the app talks to, and every setting it reads — is the platform's, with the rule on or off.",
    "spec-paths": "`tests/feature/`, `tests/steps/`",
    "platform-paths": "`harness.config.ts`, `tests/internal/`, `playwright.config.ts`, `specrig.yaml`, `package.json`, `AGENTS.md`",
    tasks:
      "| a **visual change** — layout, spacing, colour, copy that no case reads | none of the cycle. One that alters what a user can do — a button that disappears, a step that is skipped — is a feature |",
    modes: modeRows(layout.cases),
    "platform-files": listing(layout.platform.map((p) => `\`${p}\``)),
    generated:
      "`tests/surface.yaml` is written by `npx --no specrig surface`, `specrig.md` by `npx --no specrig agents`, and the structure of `tests/flows.yaml` by every whole run of the suite, in any mode, and never by hand; the `description` fields of `tests/flows.yaml` are written by hand, in any mode.",
    tool: "specrig",
    config: "`specrig.yaml`",
    areas: areaRows(areas),
    cases: "`.feature` files in `tests/feature/`",
    contracts: "",
    describes: `**A case describes the user and the wire.** What the user sees and does, what
reaches a backend, and where the page sends them. Not markup, class names, layout
or component structure — a case that breaks when the page is restyled was
written about the wrong thing.

**A backend answers what the scenario declared.** A number in a case comes from a
fixture, never computed inside a step. A rule a backend or a service behind it
owns is asserted as what the app does with the answer, not re-derived. A
backend's error codes are contract, held by a case.`,
    binding: `**Bind at the page, as a user.** Steps drive the browser the way a user does:
click the text or label a user clicks, type into the field a user types into.
Find elements by role and accessible name; read state by role (\`toBeChecked\`,
\`toBeDisabled\`). No CSS selectors, no test ids, no reaching into the app —
\`window\`, React state, query cache. When an element cannot be found that way,
the page is missing a seam: stop and say which.

**The harness** is specrig, set up by \`harness.config.ts\`: every origin the app
talks to, which setting points at it, and the contract it answers by.
Steps import \`Given\`, \`When\`, \`Then\` from \`tests/steps/bdd.ts\` and receive the
\`edges\` fixture, with an entry for each backend \`harness.config.ts\` names:

- \`edges.<backend>.reply(method, path, status, body)\` — what the backend answers,
  set in the step that the case's reason belongs to;
- \`edges.<backend>.replyTo(method, path, query, status, body)\` — the same, for a
  request whose query has these values: the reply naming the most of them wins,
  and \`reply\` is the one naming none;
- \`edges.<backend>.requests(method, path)\` — what reached the backend, with query
  and body, for a \`Then\`;
- \`edges.visited\` — the URLs the page sent the user to.

A call to a backend no step answered fails the test, and so does a request to an
origin \`harness.config.ts\` does not name.

A backend \`harness.config.ts\` names a contract for is held to it: every answer a
step declares, and every body the app sends, is checked against the contract, so
a stand-in cannot answer what the backend cannot, and a route, a status or a body
the contract does not have fails the test. A backend without one is checked by
nothing but the cases. Every setting the app reads, at runtime or at build, is
answered from \`harness.config.ts\`.

**What may be stood in for is given, not chosen.** \`harness.config.ts\` and
\`tests/internal/\` are read-only. A case that needs another origin, or an answer
the stand-in cannot give, is a stop: name the origin or the behaviour, and the
assertion it would carry.

**Time.** Set fixture dates relative to today — most cases need no clock. A case
that needs a fixed date sets it in its own \`Given\` with \`page.clock\`.`,
  }
  const part = (p: string) => render(p, slots).trimEnd()

  const sections = [
    part("header"),
    part("contributing"),
    "## The short version",
    part("short"),
    part("rule11"),
    "## Running",
    `${suite} runs the suite, with Playwright's
browsers installed (\`npx --no playwright install\`); it ${serving}.`,
    `\`tests/internal/\` holds the checks that run before any case: the app boots, and
\`harness.config.ts\` answers every setting the app reads, at runtime and at build.`,
    `The two records below are specrig's format, which a project's flow map reads
beside its backends' records. Each is rewritten by what has its source, and
nothing compares it on the way: a project that rewrites them in CI and then runs
\`git diff --exit-code\` sees a record that fell behind as a diff.`,
    `\`tests/surface.yaml\` is what the code can request; \`npx --no specrig surface\`
rewrites it. What a record cannot learn from the code — the backend a client
calls, when the project cannot tell — goes into \`specrig.yaml\` beside it.`,
    `\`tests/flows.yaml\` is what the cases make the app send: every \`When\` step, as
written, is an input, and what reached a backend after it — until the next \`When\`
or \`Given\` — is what it sent. Every whole run rewrites it, a failing one
included; a run narrowed to some cases writes nothing. Only the \`description\`
fields are written by hand: they survive a rewrite, and one whose step is gone
moves to \`orphaned\`, comes back with its step, and fails the run meanwhile.`,
  ]
  return `${sections.join("\n\n")}\n`
}

export const reference = () => render("reference", { what: "app" }).trimEnd()

export function agentsStub(service: string, parentRules: boolean): string {
  const sections = [
    "# AGENTS.md",
    `Instructions for AI coding agents working in ${service}.`,
    reference(),
    ...(parentRules
      ? [
          `The repository's rules in \`../AGENTS.md\` hold here too — ownership, the
notation for specifications, a neighbour's rules are not reproduced.`,
        ]
      : []),
    "## This app",
    `<!-- What ${service} is for, who uses it, which backends it talks to and where it
hands its users off. Written by the person who owns the platform. -->`,
  ]
  return `${sections.join("\n\n")}\n`
}
