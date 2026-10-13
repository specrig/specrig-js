import { init, type Preset, usage } from "./init.js"
import { record } from "./record.js"

export function main(args: string[], preset: Preset): number {
  const [command, ...rest] = args
  try {
    if (command === "init") {
      for (const line of init(process.cwd(), rest, preset)) {
        console.log(line)
      }
      return 0
    }
    if (command === "record" && rest.length === 0) {
      return record(process.cwd())
    }
    throw new Error(usage)
  } catch (err) {
    console.error((err as Error).message)
    return 1
  }
}
