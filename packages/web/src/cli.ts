import path from "node:path"
import { pathToFileURL } from "node:url"
import type { Config } from "./config.js"
import { init, type Preset, usage } from "./init.js"
import { writeSurface } from "./surface.js"

export async function main(args: string[], preset: Preset): Promise<number> {
  const [command, ...rest] = args
  try {
    if (command === "init") {
      for (const line of init(process.cwd(), rest, preset)) {
        console.log(line)
      }
      return 0
    }
    if (command === "surface" && rest.length === 0) {
      if (writeSurface(await harnessConfig(process.cwd()))) {
        console.log("wrote tests/surface.yaml")
      }
      return 0
    }
    throw new Error(usage)
  } catch (err) {
    console.error((err as Error).message)
    return 1
  }
}

async function harnessConfig(dir: string): Promise<Config> {
  const loaded = await import(pathToFileURL(path.join(dir, "harness.config.ts")).href)
  return loaded.default as Config
}
