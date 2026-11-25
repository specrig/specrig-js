import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { expect, test } from "@playwright/test"
import type { Config } from "../src/config.js"
import { built } from "../src/server.js"

const git = (root: string, ...args: string[]) => {
  const done = spawnSync("git", args, { cwd: root, encoding: "utf8" })
  if (done.status !== 0) {
    throw new Error(done.stderr)
  }
}

function app({ inGit = true, build = "node build.mjs" } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "specrig-build-"))
  const out = path.join(root, "..", `${path.basename(root)}.builds`)
  writeFileSync(path.join(root, "build.mjs"), `import { appendFileSync } from "node:fs"\nappendFileSync(${JSON.stringify(out)}, "built\\n")\n`)
  writeFileSync(path.join(root, "app.js"), "export const name = 'Corner shop'\n")
  mkdirSync(path.join(root, "tests", "steps"), { recursive: true })
  writeFileSync(path.join(root, "tests", "steps", "shop.ts"), "// the shop's steps\n")
  if (inGit) {
    git(root, "init", "--quiet")
    git(root, "add", ".")
  }
  const config: Config = {
    root,
    service: "shop",
    backends: { api: { origin: "https://api.shop.test", env: "VITE_API_URL" } },
    surface: { client: "HttpClient" },
    server: { command: "node server.mjs", build },
  }
  return {
    root,
    config,
    builds: () => (existsSync(out) ? readFileSync(out, "utf8").split("\n").filter(Boolean).length : 0),
    run: async (which: Config = config) => {
      const before = process.env.SPECRIG_RUN
      process.env.SPECRIG_RUN = randomUUID()
      try {
        await built(which)
      } finally {
        process.env.SPECRIG_RUN = before
      }
    },
  }
}

test("a run whose app has not changed since the last build serves that build", async () => {
  const shop = app()

  await shop.run()
  await shop.run()

  expect(shop.builds()).toBe(1)
})

test("a run builds again once a file of the app changes", async () => {
  const shop = app()
  await shop.run()

  writeFileSync(path.join(shop.root, "app.js"), "export const name = 'Tea house'\n")
  await shop.run()

  expect(shop.builds()).toBe(2)
})

test("a run builds again once the app has a new file, committed or not", async () => {
  const shop = app()
  await shop.run()

  writeFileSync(path.join(shop.root, "prices.js"), "export const tea = 3\n")
  await shop.run()

  expect(shop.builds()).toBe(2)
})

test("a run builds again once a file of the app is gone", async () => {
  const shop = app()
  writeFileSync(path.join(shop.root, "prices.js"), "export const tea = 3\n")
  git(shop.root, "add", ".")
  await shop.run()

  rmSync(path.join(shop.root, "prices.js"))
  await shop.run()

  expect(shop.builds()).toBe(2)
})

test("a run builds again once the variables the build is given change", async () => {
  const shop = app()
  await shop.run()

  await shop.run({ ...shop.config, build: { constants: { VITE_SHOP_NAME: "Tea house" } } })

  expect(shop.builds()).toBe(2)
})

test("a changed step, case or record of the tests is not built", async () => {
  const shop = app()
  await shop.run()

  appendFileSync(path.join(shop.root, "tests", "steps", "shop.ts"), "// one step more\n")
  writeFileSync(path.join(shop.root, "tests", "flows.yaml"), "specrig: flows/2\n")
  await shop.run()

  expect(shop.builds()).toBe(1)
})

test("a file git ignores is not built", async () => {
  const shop = app()
  writeFileSync(path.join(shop.root, ".gitignore"), "dist/\n")
  await shop.run()

  mkdirSync(path.join(shop.root, "dist"))
  writeFileSync(path.join(shop.root, "dist", "app.js"), "built\n")
  await shop.run()

  expect(shop.builds()).toBe(1)
})

test("a build that failed is run again on the next run", async () => {
  const shop = app({ build: "node build.mjs && exit 1" })
  await expect(shop.run()).rejects.toThrow(/exited with code 1/)

  await expect(shop.run()).rejects.toThrow(/exited with code 1/)

  expect(shop.builds()).toBe(2)
})

test("a run of an app outside git builds every time", async () => {
  const shop = app({ inGit: false })

  await shop.run()
  await shop.run()

  expect(shop.builds()).toBe(2)
})

test("SPECRIG_REBUILD builds whatever the last build was", async () => {
  const shop = app()
  await shop.run()

  process.env.SPECRIG_REBUILD = "1"
  try {
    await shop.run()
  } finally {
    delete process.env.SPECRIG_REBUILD
  }

  expect(shop.builds()).toBe(2)
})
