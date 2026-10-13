import { spawnSync } from "node:child_process"

export const recording = () => Boolean(process.env.SPECRIG_RECORD)

// The app's own test script, so that a record runs what a check runs.
export function record(dir: string): number {
  const run = spawnSync("npm", ["test"], { cwd: dir, env: { ...process.env, SPECRIG_RECORD: "1" }, stdio: "inherit" })
  return run.status ?? 1
}
