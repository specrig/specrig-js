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
- **Two records, kept by the suite.** `tests/surface.yaml` is what the code can
  request, read from the code. `tests/flows.yaml` is what the cases make the app
  send, step by step. A run fails when either falls behind.
- **A protocol for the people and agents who write the cases.** `init` writes an
  `AGENTS.md` that holds an agent to the order: cases, approval, then code.

specrig is not on npm yet; see [Before publication](#before-publication).

## Packages

| package | what it is |
|---|---|
| [`@specrig/web`](packages/web) | the core, independent of the build tool: the harness, the contract check, the records, the reporter, and the engine behind `init` |
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
| `--flows` | write `waffle.yaml`, the marker by which `waffle flows` finds the app |

`init` writes no file that exists. It writes:

| file | who changes it |
|---|---|
| `harness.config.ts` | whoever owns the platform: a new origin, a new setting |
| `playwright.config.ts`, `Makefile`, `tests/internal/` | nobody, as a rule |
| `tests/internal/boot.spec.ts` | the answers an empty app needs to boot, if any |
| `tests/steps/bdd.ts` | nobody: it is where steps import `Given`, `When`, `Then` from |
| `tests/feature/` | the cases |
| `AGENTS.md`, and `CLAUDE.md` linked to it | its "This app" section, once |

and adds `@playwright/test`, `playwright-bdd` and the two specrig packages to
`devDependencies`, a `test` script if there is none, and the test output to
`.gitignore`.

Then:

```bash
make record
```

runs the suite once and writes `tests/surface.yaml` and `tests/flows.yaml`. From
then on `make test` runs the suite in Playwright's image, so no local Node is
needed. With Node installed, `npm test` and `npx specrig record` do the same.

## Writing a case

A case is a scenario in `tests/feature/`:

```gherkin
Feature: The shop

  Scenario: The visitor sees what the shop sells
    Given the shop sells "Tea" and "Coffee"
    When the visitor opens the shop
    Then they see "Tea" and "Coffee"
```

`make test` without steps prints the snippets to start from. Steps receive the
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
| `edges.<backend>.requests(method, path)` | what reached the backend, with query and body |
| `edges.visited` | the pages the app sent the user to |

A call no step answered gets a 501 and fails the test, named. After the test, every
request and every answer is checked against the backend's contract: an unknown
route, an undocumented status, or a body of the wrong shape fails it.

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

**`tests/surface.yaml`** lists the requests the code can send, by the client that
sends them. It is read from the code through the TypeScript compiler, for a
TypeScript app or a JavaScript one with a `jsconfig.json`: every call to the
client's `get`, `post`, `put`, `patch` or `delete`, its path followed through
constants, templates and the callers of the function that builds it. A segment
that varies is written `{}`.

**`tests/flows.yaml`** lists what the cases make the app send. Every `When` step,
as written, is an input, and what reached a backend after it — until the next
`When` or `Given` — is what it sent, named by the route of the backend's contract
that takes it, or as sent for a backend with no contract. Only the `description`
fields are written by hand, and they survive a rewrite.

`make test` compares both and fails on a difference. `make record` rewrites them:
`tests/surface.yaml` on any run, `tests/flows.yaml` only when the whole run is green.

## The protocol

The `AGENTS.md` that `init` writes holds the people and agents who write the cases
to three steps, with a stop after each: the cases, then approval by a human, then
the code, changed until every case that was red for its own reason is green. Every
edit is made in a mode only the human switches — spec, redgreen or platform — and
an edit the mode does not allow is a stop.

## Limits

- Vite is the only build tool with an adapter.
- Requests are read from one client class; an app that calls `fetch` or a library
  directly has no `tests/surface.yaml` to speak of.
- The generated `Makefile` expects the app one directory below the repository root
  that holds the contracts.

## Before publication

Until the packages are on npm, an app installs them from a checkout of this
repository, built with `npm install && npm run build`, and unsaved, so that
`package.json` stays installable without it:

```bash
npm install --no-save --install-links ../specrig-js/packages/web ../specrig-js/packages/vite
```

`init` run from a checkout writes a `Makefile` that does this in Playwright's image,
with the checkout mounted beside the app's repository:

```bash
node ../specrig-js/packages/vite/dist/cli.js init --backend api=apiUrl
```

## Development

```bash
make test
```

builds both packages and runs their tests in Playwright's image, then the suite of
the app in `packages/vite/test/app`, which reads its backend's address at build.

## License

[MIT](LICENSE)
