import path from "node:path"
import { pathToFileURL } from "node:url"
import type { Config } from "./config.js"
import { agents, init, type Preset, usage } from "./init.js"
import { rules } from "./layout.js"
import { writeSurface } from "./surface.js"

type Command = (dir: string, args: string[], preset: Preset) => string[] | Promise<string[]>

const commands: Record<string, Command> = {
  init: (dir, args, preset) => init(dir, args, preset),
  surface: async (dir, args) => {
    if (args.length > 0) {
      throw new Error(`surface takes no arguments\n\n${usage}`)
    }
    return writeSurface(await harnessConfig(dir)) ? ["wrote tests/surface.yaml"] : []
  },
  agents: (dir, args, preset) => {
    if (args.length > 0) {
      throw new Error(`agents takes no arguments\n\n${usage}`)
    }
    return agents(dir, preset)
  },
  rules: (dir, args) => {
    if (args.length > 0) {
      throw new Error(`rules takes no arguments\n\n${usage}`)
    }
    return [JSON.stringify(rules(dir))]
  },
}

export async function main(args: string[], preset: Preset): Promise<number> {
  const [command, ...rest] = args
  if (command === "--help" || command === "-h") {
    console.log(usage)
    return 0
  }
  if (command === undefined) {
    console.error(usage)
    return 1
  }
  if (!Object.hasOwn(commands, command)) {
    console.error(`Unknown command "${command}"\n\n${usage}`)
    return 1
  }
  try {
    for (const line of await commands[command](process.cwd(), rest, preset)) {
      console.log(line)
    }
    return 0
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`)
    return 1
  }
}

async function harnessConfig(dir: string): Promise<Config> {
  const loaded = await import(pathToFileURL(path.join(dir, "harness.config.ts")).href)
  return loaded.default as Config
}
