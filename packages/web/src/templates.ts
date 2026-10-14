type Pointer = { field?: string; env?: string }

export type Plan = {
  service: string
  playwright: string
  adapter: string
  local?: { checkout: string; packages: string[] }
  serving: string
  backends: ({ name: string; origin: string; contract?: string; failure?: string } & Pointer)[]
  pages: ({ name: string; origin: string } & Pointer)[]
  runtime?: string[]
  build: string[]
  parentRules: boolean
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

export function makefile(plan: Plan): string {
  const run = (mount: string) =>
    `RUN := docker run --rm --ipc=host -v $(CURDIR)/..:/repo${mount} -v $(REPO)-$(APP)-test-node-modules:/repo/$(APP)/node_modules -w /repo/$(APP) $(PLAYWRIGHT) sh -c`
  const head = `PLAYWRIGHT := mcr.microsoft.com/playwright:v${plan.playwright}-noble
APP := $(notdir $(CURDIR))
REPO := $(notdir $(abspath $(CURDIR)/..))
`
  const targets = `
test:
\t$(RUN) '$(INSTALL) && npm test'

generate:
\t$(RUN) '$(INSTALL) && npx specrig surface'

.PHONY: test generate
`
  if (!plan.local) {
    return `${head}
# The whole repository, read for the backends' contracts.
${run("")}
INSTALL := npm install --legacy-peer-deps --no-audit --no-fund
${targets}`
  }
  const packages = plan.local.packages.map((p) => `/specrig/${p}`).join(" ")
  return `${head}SPECRIG ?= $(CURDIR)/${plan.local.checkout}

# The whole repository, read for the backends' contracts. specrig is copied afresh
# from its checkout and not saved: the image installs from package.json and has no checkout.
${run(" -v $(SPECRIG):/specrig:ro")}
INSTALL := rm -rf node_modules/@specrig && npm install --no-save --install-links --legacy-peer-deps --no-audit --no-fund ${packages}
${targets}`
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

export function agents(plan: Plan): string {
  const app = plan.service
  const backend = plan.backends[0]
  const name = backend.name
  const contract = backend.contract
    ? `Every answer a step declares, and every body the app sends, is checked against
${name}'s contract, \`${backend.contract}\`: a stand-in cannot answer what ${name}
cannot, and a route, a status or a body the contract does not have fails the test.
Every setting the app reads, at runtime or at build, is answered from
\`harness.config.ts\`.`
    : `${name} has no contract named in \`harness.config.ts\`, so what a stand-in answers
is checked by nothing but the cases. Every setting the app reads, at runtime or
at build, is answered from \`harness.config.ts\`.`
  const npm = plan.local
    ? "With Node installed, `npm test` does the same once specrig is installed the way\nthe Makefile installs it."
    : "With Node installed, `npm test` does the same."
  const parent = plan.parentRules
    ? `
The repository's rules in \`../AGENTS.md\` hold here too — ownership, the
notation for specifications, a neighbour's rules are not reproduced.
`
    : ""

  return `# AGENTS.md

Instructions for AI coding agents working in ${app}.

**Read \`CONTRIBUTING.md\` first, if it exists.** It overrides this file wherever
the two disagree, Rule #11 included. It belongs to the humans who own ${app}:
when you learn something that belongs there, quote what you would write, and do
not write it.
${parent}
## This app

<!-- What ${app} is for, who uses it, which backends it talks to and where it
hands its users off. Written by the person who owns the platform. -->

## The short version

- **Three steps, and you stop after each one.** Cases → *hand over and wait* →
  red-green. Being asked for one step is not being asked for the next, and an
  answer you get inside a step is not the next step either.
- **Every edit is made in a mode the human switched on.** An edit the mode does
  not allow is a stop: name the mode that allows it and ask.
- **Three things you do not write.** The platform's files, \`CONTRIBUTING.md\`,
  and production code before the cases are approved.
- **One stop-and-report.** What a scenario may stand in for is given: when it
  does not fit the case, name what you need and hand it back.
- **After every edit,** \`make test\`.

## Rule #11 — specification before code

### Whether this rule applies here

It is a convention, and ${app} may decline it — by a paragraph in
\`CONTRIBUTING.md\` that says so about this rule. Do not infer an opt-out from
remarks about pace or deadlines, and do not write one: an agent that writes its
own exemption has not found one. The platform boundary does not fall with it.

### Who decides what

| | owns | in this repository |
|---|---|---|
| the person writing the specification | the cases, the steps, the red-green loop | \`tests/feature/\`, \`tests/steps/\` |
| the person who owns the platform | what may be stood in for, and the harness | \`harness.config.ts\`, \`tests/internal/\`, \`playwright.config.ts\`, \`package.json\`, this file |

**You work for the first.** The platform is a given: read it, use it, and when it
does not fit the case, say so and stop.

### Which task this is

| task | what to do |
|---|---|
| a feature, or a **design defect** — behaviour that was specified and contradicts itself | the full cycle below |
| a **code defect** in one function — code that broke, not behaviour that was contradictory | fix it, with a case if one is cheap. None of the cycle |
| a **visual change** — layout, spacing, colour, copy that no case reads | none of the cycle |
| a **spike** | exempt, but its output is a specification, not merged code |

Which kind a task is, is the human's call when it is not obvious. A visual change
that alters what a user can do — a button that disappears, a step that is
skipped — is a feature.

### Modes

Every edit is made in a mode, and **only the human switches it**, by naming it:
"spec mode", "redgreen mode", "platform mode". Nothing in this repository
enforces the table yet, so you hold it yourself.

| mode | may be edited |
|---|---|
| none | anything but the cases and the platform's files |
| spec | \`tests/feature/**/*.feature\` |
| redgreen | the steps and production code — anything but the cases and the platform's files |
| platform | the platform's files, and production code for a seam |

The platform's files are \`harness.config.ts\`, \`tests/internal/\`,
\`playwright.config.ts\`, \`package.json\`, \`package-lock.json\`, \`Makefile\`,
\`specrig.yaml\` where there is one, and this file.
\`tests/surface.yaml\` and the structure of \`tests/flows.yaml\` are written by
\`make generate\` and by every whole run of the suite, in any mode, and never by
hand.
\`CONTRIBUTING.md\` is edited in no mode.

\`package.json\` and \`package-lock.json\` can be granted in redgreen mode, by the
human naming them, until the mode changes: a dependency the production code needs
is not a platform change.

**An edit the mode does not allow is a stop.** Name the mode that allows it and
ask. An answer to your question switches nothing, and neither does an imperative
inside a step.

### 0. When the code came first

${app} has behaviour nobody wrote down. Before the first change that touches it,
derive a **baseline** from the code: what it does today, in the notation the
cases will use. Every case in it carries a verdict:

- **✓** confirmed as intended — a regression boundary.
- **✗** confirmed defect — the case asserts the *intended* behaviour and is red
  until the fix lands.
- **?** no verdict. Only the human moves it. Do not guess, and do not mark ✓
  because the code is old.

The verdict belongs to the baseline, which is not committed. A committed case
carries the **reason**: the rule as it stands, in the present tense, and what it
excludes — no verdict tags, no status lines, no counts.

### 1. Requirements in, specification out

Produce two artifacts and nothing else yet:

- **the cases** — \`.feature\` files in \`tests/feature/\`. The minimum set that
  pins down what the requirements left open, not an exhaustive matrix.
- **a delta list** — every place the cases say something the source document
  does not, and what was deliberately left out of scope. It belongs with the
  ticket and is not committed.

For a design defect the deliverable is the set of cases that cannot all pass at
once.

### Writing the cases

**A case is verified against the requirements, not the code.** A case that
disagrees with the code is a red case to report, never one to align with it.

**A case for a known defect asserts the behaviour you want, so it is red.** The
number of red cases equals the number of known defects; a mismatch means a defect
got frozen or a case is wrong.

**A case describes the user and the wire.** What the user sees and does, what
reaches ${name}, and where the page sends them. Not markup, class names, layout
or component structure — a case that breaks when the page is restyled was
written about the wrong thing.

**${name} answers what the scenario declared.** A number in a case comes from a
fixture, never computed inside a step. A rule ${name} or a service behind it
owns is asserted as what ${app} does with the answer, not re-derived. ${name}'s
error codes are contract, held by a case.

**Name what the case excludes.** For "X comes from Y", say which implementation
would also pass and should not. If one exists, vary the fixture.

**The negative is written, never implied.** "No payment is requested" is a
\`Then\`. An assertion that exists only as a missing line cannot be reviewed.

**State the contract facts the cases lean on** — retries, where a signed-in
user's tokens live — here, as they are found:

<!-- None written yet. -->

**Fold duplicates along one axis only**: same setup and trigger, different
expectation, is one \`Scenario Outline\`. A different setup is a different case.

### 2. Verification, then approval

Say that the arithmetic was read, not run — about one number in a hundred will be
wrong. A human reads the source document and the delta list, then corrects or
approves. **No production code before approval.**

**Approval is an event, and it has not happened yet** when you finish the cases.
Hand over what you have, say what you expect to be red and why, list what needs
deciding, and wait. A reply to your question — "forbid it", "do B" — settles a
row; it is not the next step.

### 3. Red-green

The cases are **frozen** at approval. Bind them and run them red, then change
production code until they are green.

**Bind at the page, as a user.** Steps drive the browser the way a user does:
click the text or label a user clicks, type into the field a user types into.
Find elements by role and accessible name; read state by role (\`toBeChecked\`,
\`toBeDisabled\`). No CSS selectors, no test ids, no reaching into the app —
\`window\`, React state, query cache. When an element cannot be found that way,
the page is missing a seam: stop and say which.

**The harness** is specrig, set up by \`harness.config.ts\`: every origin the app
talks to, which setting points at it, and the contract it answers by.
Steps import \`Given\`, \`When\`, \`Then\` from \`tests/steps/bdd.ts\` and receive the
\`edges\` fixture:

- \`edges.${name}.reply(method, path, status, body)\` — what ${name} answers, set
  in the step that the case's reason belongs to;
- \`edges.${name}.replyTo(method, path, query, status, body)\` — the same, for a
  request whose query has these values: the reply naming the most of them wins,
  and \`reply\` is the one naming none;
- \`edges.${name}.requests(method, path)\` — what reached ${name}, with query and
  body, for a \`Then\`;
- \`edges.visited\` — the URLs the page sent the user to.

A call to ${name} no step answered fails the test, and so does a request to an
origin \`harness.config.ts\` does not name.

${contract}

**What may be stood in for is given, not chosen.** \`harness.config.ts\` and
\`tests/internal/\` are read-only. A case that needs another origin, or an answer
the stand-in cannot give, is a stop: name the origin or the behaviour, and the
assertion it would carry.

**Time.** Set fixture dates relative to today — most cases need no clock. A case
that needs a fixed date sets it in its own \`Given\` with \`page.clock\`.

**The red half is done when every case is red for its own reason.** A case red
because a step is missing, or a page that does not load, is not that. No
behaviour before that run.

**Green.** Never weaken an assertion, widen a matcher, delete a case or relax a
fixture. A case that was never red has not been shown to fail: put the old
behaviour back for one run and watch exactly that case fail. Every production file
in the diff is named by a case that went red. A step can be the thing that is
wrong — read a failure before believing it.

### Changing an approved specification

Only through the human who approved it. Two triggers: two approved cases cannot
both hold, or a case needs something ${app} does not own. State it and stop.

### What the merge request carries

The cases as a diff, and a link to the ticket where the delta list was argued.
What the diff of a specification task must not carry, checkable at a glance:

- **any file under \`src/\`** — production code before approval;
- **the platform's files** — the task granted itself what it was working under;
- **\`CONTRIBUTING.md\`**.

## Running

\`make test\` runs the suite in Playwright's image, so no local Node is needed; it
${plan.serving}.
${npm}

\`tests/internal/\` holds the checks that run before any case: the app boots, and
\`harness.config.ts\` answers every setting the app reads, at runtime and at build.

The two records below are specrig's format, which a project's flow map reads
beside its backends' records. Each is rewritten by what has its source, and
nothing compares it on the way: CI runs \`make generate\` and \`make test\`, then
\`git diff --exit-code\`, so a record that fell behind is a diff.

\`tests/surface.yaml\` is what the code can request; \`make generate\` rewrites it.
What a record cannot learn from the code — the backend a client calls, when the
project cannot tell — goes into \`specrig.yaml\` beside it.

\`tests/flows.yaml\` is what the cases make the app send: every \`When\` step, as
written, is an input, and what reached a backend after it — until the next \`When\`
or \`Given\` — is what it sent. Every whole run rewrites it, a failing one
included; a run narrowed to some cases writes nothing. Only the \`description\`
fields are written by hand: they survive a rewrite, and one whose step is gone
moves to \`orphaned\`, comes back with its step, and fails the run meanwhile.
`
}
