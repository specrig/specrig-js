# specrig

A Playwright harness for a web app developed specification first: the cases are
written and approved before the code, and the code is changed until they pass.

- **Backends are stood in for by their contract.** Every origin the app talks to is
  named in `harness.config.ts`. A step declares what a backend answers; the answer
  and every request the app sends are checked against the backend's OpenAPI
  document. A request to an origin the config does not name, a call no step
  answered, or anything the contract does not allow fails the test.
- **Every setting the app reads is answered.** Whether the app reads its backend's
  address at runtime (`/config.js`) or at build (`import.meta.env.VITE_*`), the
  harness points it at the stand-in, and a check fails when the app reads a setting
  the config does not answer.
- **Two records in specrig's format.** `tests/surface.yaml` is what the code can
  request, read from the code. `tests/flows.yaml` is what the cases make the app
  send, step by step. A project's flow map reads them beside its backends'
  records — `waffle flows` does.
- **Rule #11 for the people and agents who write the cases.** `init` writes
  `specrig.md`, which holds an agent to the order: cases, approval, then code, each
  edit in a mode the human switched on, and one line in the app's `AGENTS.md`
  brings it in. `specrig agents` rewrites it, and `specrig rules` gives the
  specrig plugin for Claude Code the app's rules, so it refuses an edit the mode
  does not allow before it happens.

## Packages

| package | what it is |
|---|---|
| [`@specrig/web`](packages/web) | the core, independent of the build tool: the harness, the contract check, the records, the reporter, the rules of the Rule #11 modes, and the engine behind `init` |
| [`@specrig/vite`](packages/vite) | for an app built with Vite: the `runtimeConfig` plugin, the settings checks, the `webServer` helper, and the `specrig` command |

## Getting started

In the app's directory:

```bash
npx @specrig/vite init --backend api=apiUrl --contract api=../docs/openapi.yaml
```

`--backend` names a backend the app's HTTP client calls and the setting that points
at it: a field of the runtime config, or a variable the build reads. `init` finds
the settings itself — the map handed to `runtimeConfig(...)` in the Vite config,
and every `import.meta.env.*` read under `src/` — and refuses a setting the app
does not read. Every other setting ending in `Url` or `URL` becomes a page the app
sends its users to; the rest become constants the harness answers empty.

| option | |
|---|---|
| `--backend <name>[=<setting>]` | a backend and the setting that points at it; repeatable |
| `--contract <name>=<path>` | its OpenAPI document, from the app's directory |
| `--failure <name>=<schema>` | the schema of a 5xx it may answer on any route |
| `--service <name>` | the app's name in its records; `package.json`'s by default |

`init` writes no file that exists, save `specrig.md` and the line an `AGENTS.md`
lacks. It writes:

| file | who changes it |
|---|---|
| `harness.config.ts` | whoever owns the platform: a new origin, a new setting |
| `playwright.config.ts`, `tests/internal/` | nobody, as a rule |
| `specrig.yaml`, naming the tool the plugin asks: `guard: [npx, --no, specrig]` | whoever owns the platform: an area, a client's backend |
| `tests/internal/boot.spec.ts` | the answers an empty app needs to boot, if any |
| `tests/steps/bdd.ts` | nobody: it is where steps import `Given`, `When`, `Then` from |
| `tests/feature/` | the cases |
| `AGENTS.md`, and `CLAUDE.md` linked to it; to an `AGENTS.md` there already, the line that brings `specrig.md` in | whoever owns the platform: what the app is for |
| `specrig.md` | nobody: `specrig agents` rewrites it |

and adds `@playwright/test`, `playwright-bdd` and the two specrig packages to
`devDependencies`, a `test` script if there is none, and the test output to
`.gitignore`. A `specrig.yaml` that is there already and names no guard is kept,
and `init` says to add the line.

Then:

```bash
npx --no specrig surface
```

```bash
npx --no specrig agents
```

```bash
npx --no bddgen && npx --no playwright test
```

The first writes `tests/surface.yaml` from the code, the second `specrig.md` from
`specrig.yaml`, and the third runs the suite, with Playwright's browsers installed
by `npx playwright install`, and writes `tests/flows.yaml`. How and where they run
— a `Makefile`, the `package.json` scripts, CI — is the project's. The `agents`
command fails while `AGENTS.md` does not bring `specrig.md` in, or still carries
Rule #11 from before there was one.

## Writing a case

A case is a scenario in `tests/feature/`:

```gherkin
Feature: The shop

  Scenario: The visitor sees what the shop sells
    Given the shop sells "Tea" and "Coffee"
    When the visitor opens the shop
    Then they see "Tea" and "Coffee"
```

The suite without steps prints the snippets to start from. Steps receive the
`edges` fixture:

```ts
import { expect } from "@playwright/test"
import { Given, Then, When } from "./bdd"

Given("the shop sells {string} and {string}", async ({ edges }, first: string, second: string) => {
  edges.api.reply("GET", "/items", 200, [{ name: first }, { name: second }])
})

When("the visitor opens the shop", async ({ page }) => {
  await page.goto("/")
})

Then("they see {string} and {string}", async ({ page }, first: string, second: string) => {
  await expect(page.getByRole("listitem")).toHaveText([first, second])
})
```

| | |
|---|---|
| `edges.<backend>.reply(method, path, status, body)` | what the backend answers |
| `edges.<backend>.replyTo(method, path, query, status, body)` | the same, for a request whose query has these values; the reply naming the most of them wins |
| `edges.<backend>.hold(method, path, query?)` | the requests the query takes wait until a step releases them; the hold naming the most of the query takes a request |
| `edges.<backend>.release(method, path, query?)` | answers what that hold kept waiting with what the backend answers by then, and what comes after it at once |
| `edges.<backend>.requests(method, path)` | what reached the backend, with query and body |
| `edges.visited` | the pages the app sent the user to |

A call no step answered gets a 501 and fails the test, named. After the test, every
request and every answer is checked against the backend's contract: an unknown
route, an undocumented status, or a body of the wrong shape fails it.

A held request does not keep the harness waiting after a step, and one no step
released fails the test, named, unless the app gave up on it. So a case can see what
the app shows while it waits, give it two answers in the order the case chooses, or
pass its timeout:

```gherkin
  Scenario: The visitor sees the shop loading until it answers
    Given the shop sells "Tea" and "Coffee"
    And the shop is slow to answer
    When the visitor opens the shop
    Then they see the shop loading
    When the shop answers
    Then they see "Tea" and "Coffee" under "Corner shop"
```

The second step holds — `edges.api.hold("GET", "/items")` — and the fifth releases —
`await edges.api.release("GET", "/items")`. A timeout is a hold no step releases,
passed on the test's clock: `page.clock.install()` before the request, then
`page.clock.runFor(...)` past the timeout, which that clock counts when the app does
with `setTimeout` or `AbortSignal.timeout`.

## `harness.config.ts`

```ts
import { defineConfig } from "@specrig/web"

export default defineConfig({
  root: import.meta.dirname,
  service: "shop",
  runtime: { path: "/config.js", global: "__CONFIG__", constants: { mapsKey: "" } },
  build: { constants: { VITE_SHOP_NAME: "Corner shop" } },
  backends: {
    api: { origin: "https://api.shop.test", field: "apiUrl", contract: "../docs/openapi.yaml", failure: "Error" },
  },
  pages: {
    help: { origin: "https://help.shop.test", env: "VITE_HELP_URL" },
  },
  assets: {
    maps: { origin: "https://maps.example.com" },
  },
  surface: { client: "HttpClient" },
})
```

| key | |
|---|---|
| `backends` | origins stood in for; `field` or `env` is the setting that points the app at one |
| `pages` | origins the app sends its users to; a navigation there is recorded in `edges.visited` and answered with an empty page |
| `assets` | origins the app loads images or scripts from; answered empty |
| `runtime` | the script the harness serves at `path` as `window.<global>`: the fields that point at stand-ins, and the constants |
| `build` | the constants the build is given, beside the variables that point at stand-ins |
| `surface` | the class through which the app sends its requests; `tsconfig` and `sources` if not `tsconfig.app.json` and `src` |

## Settings: at runtime or at build

An app reads its backend's address one of two ways, and `init` sets up whichever it
finds.

**At runtime.** `runtimeConfig` serves the settings as a script in dev and preview,
from `.env`, and leaves `config.js.template` in the build for the image to fill from
its environment at start:

```ts
import { runtimeConfig } from "@specrig/vite"

export default defineConfig({
  plugins: [runtimeConfig({ apiUrl: "API_URL", mapsKey: "MAPS_KEY" })],
})
```

The harness serves its own `/config.js` with the stand-ins' origins. The check
reads the settings from the script the app's server answers with, so it holds for
any server that serves one.

**At build.** The app reads `import.meta.env.VITE_API_URL`. `webServer(harness)` in
`playwright.config.ts` builds the app with the stand-ins' origins in the
environment, which Vite prefers to `.env`. The check reads every
`import.meta.env.*` under `src/`.

## The records

Both are specrig's format and say so first — `specrig: surface/1`,
`specrig: flows/1` — so that a project's flow map, such as `waffle flows`, finds
the app by them and reads them beside its backends' records. Each is rewritten by
what has its source, and nothing compares it on the way: a project that rewrites
them in CI and then runs `git diff --exit-code` sees a record that fell behind as
a diff.

**`tests/surface.yaml`** lists the requests the code can send, by the client that
sends them; `specrig surface` writes it. It is read from the
code through the TypeScript compiler, for a TypeScript app or a JavaScript one
with a `jsconfig.json`: every call to the client's `get`, `post`, `put`, `patch`
or `delete`, its path followed through constants, templates and the callers of
the function that builds it. A segment that varies is written `{}`. What a record
cannot learn from the code — the backend a client calls, when the project cannot
tell — goes into `specrig.yaml` beside it:

```yaml
flows:
  clients:
    lib/http-client.httpClient: apostle
```

**`tests/flows.yaml`** lists what the cases make the app send. Every `When` step,
as written, is an input, and what reached a backend after it — until the next
`When` or `Given` — is what it sent, named by the route of the backend's contract
that takes it, or as sent for a backend with no contract. Before the next step the
harness waits for what the page has yet to send: the requests in flight, every
timer of up to a second the page arms within a second of the step — a debounce, a
retry, through the test's clock too — and the work the page has queued, such as a
render; then 50 ms with nothing more. Every whole run rewrites it, a failing one
included; a run narrowed to some cases writes nothing. Only the `description`
fields are written by hand: they survive a rewrite, and one whose step is gone
moves to `orphaned`, comes back with its step, and fails the run meanwhile.

## Modes and rules

The `specrig.md` that `init` writes holds the people and agents who write the cases
to three steps, with a stop after each: the cases, then approval by a human, then
the code, changed until every case that was red for its own reason is green. Every
edit is made in a mode only the human switches — spec, redgreen or platform, and
redgreen until one is switched — and an edit the mode does not allow is a stop. Auto mode, which the human
switches on too and nothing offers, runs the whole cycle without a stop for a
human who reviews it all at once; it takes the areas and grants of spec and
redgreen, and keeps the platform's files closed.

`specrig rules` prints, for the app it runs in, the modes, the classes its layout
fills and its areas, as one line of JSON —
[rules/1](https://github.com/specrig/protocol/blob/main/guard.md#rules1), what the
plugin checks every edit against:

```bash
npx --no specrig rules
```

It switches nothing: which mode is on, and what was granted, is the plugin's to
hold. A path takes the first class that names it:

| class | paths | open in |
|---|---|---|
| the humans' | `CONTRIBUTING.md` | no mode |
| generated | `specrig.md`, `tests/surface.yaml` | no mode |
| platform | `harness.config.ts`, `tests/internal/`, `playwright.config.ts`, `specrig.yaml`, `AGENTS.md`, `CLAUDE.md` | platform |
| cases | `tests/feature/**/*.feature` | spec, auto |
| tests | the rest of `tests/` | redgreen, auto |
| production | everything else | redgreen, platform, auto |

An area is a named set of paths. One with its own modes takes its paths out of
the class table; one without follows it, and its grant only adds:

| area | paths | open in | granted in |
|---|---|---|---|
| deps | `package.json`, `package-lock.json` | platform | redgreen |
| flows | `tests/flows.yaml` | spec, redgreen, platform | — |
| steps | `tests/steps/` | as the table says | platform |

`specrig.yaml` replaces a default by naming it, and adds its own — a monorepo's
shared contracts, say. An area naming a mode the table does not have is an error
that names the area.

```yaml
guard: [npx, --no, specrig]
agents:
  areas:
    contracts:
      paths: [../docs/api/]
      modes: [spec, platform]
```

A path is checked where it is written and where it leads through a symlink, and
refused if either is; each name is compared as its directory spells it, so on a
case-insensitive filesystem `Specrig.yaml` is `specrig.yaml`.

**The specrig plugin for Claude Code enforces the modes.** The human switches with
`/specrig:<mode>` and grants with `/specrig:allow <area>`; the plugin reads the
rules of the tool `specrig.yaml` names once a session, and refuses an edit the mode
does not allow before it happens:

```
/plugin marketplace add specrig/specrig
/plugin install specrig@specrig
```

Without it, the agent reads the same tables in `specrig.md` and holds the boundary
itself.

## The protocol

What every specrig stack agrees on — the records, the rules, the modes and the
text of `specrig.md` — is [specrig's protocol](https://github.com/specrig/protocol).
`packages/web/protocol` holds a pinned copy of its data: `modes.yaml` and
`agents/*.md`, which the published `@specrig/web` carries and `rules`, `init` and
`specrig agents` read, and the fixtures, which the tests run. Every agents fixture
goes through the check of `AGENTS.md`; a record fixture goes through the flows
writer, unless it holds what a web app never sends its writer — inputs other than
`When` steps, outputs other than HTTP, refusals — and the test says which. The
guard fixtures are the plugin's to run. This repository implements `surface/1`,
`flows/1`, `rules/1`, `modes/1` and `agents/1`.

## Limits

- Vite is the only build tool with an adapter.
- Requests are read from one client class; an app that calls `fetch` or a library
  directly has no `tests/surface.yaml` to speak of.

## From a checkout

To try a change to specrig in an app before it is released, the app installs the
packages from a checkout of this repository, built with
`npm install && npm run build`, and unsaved, so that `package.json` stays
installable without it:

```bash
npm install --no-save --install-links ../specrig-js/packages/web ../specrig-js/packages/vite
```

`init` run from a checkout adds neither package to `package.json`, and prints this
command, with the checkout's paths, to run before every run:

```bash
node ../specrig-js/packages/vite/dist/cli.js init --backend api=apiUrl
```

## Development

```bash
make test
```

builds both packages and runs their tests, then the suite of the app in
`packages/vite/test/app`, which reads its backend's address at build; Playwright's
browsers have to be installed. `make test-docker` does the same in Playwright's
image.

```bash
make protocol
```

refreshes `packages/web/protocol` from a checkout of the protocol at
`PROTOCOL`, `../protocol` by default.

### Releasing

Both packages carry one version, and a tag `v<version>` releases them: the
`publish` workflow checks that the tag names the version of both, runs the tests,
and stages both packages through npm's trusted publishing, with no token. A
maintainer then approves each with 2FA, on npmjs.com or from the CLI.

```bash
npm version 0.1.1 --workspaces --no-git-tag-version
git commit -am "chore: release 0.1.1"
git tag v0.1.1
git push origin main v0.1.1
```

```bash
npm stage list @specrig/web
npm stage approve <stage-id>
```

A caret range below 1.0 stops at the minor version, so when the minor changes,
`@specrig/vite`'s range for `@specrig/web` changes with it.

## License

[MIT](LICENSE)
