import path from "node:path"
import { fileURLToPath } from "node:url"
import type { Preset } from "@specrig/web/init"
import { envRead } from "./env.js"
import { runtimeFields, viteConfig } from "./runtime.js"

export const preset: Preset = {
  packageDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  settings: (app) => {
    const config = viteConfig(app)
    return { runtime: config ? runtimeFields(config) : undefined, build: envRead(path.join(app, "src")) }
  },
  none: "the Vite config hands no map to runtimeConfig(...), and src/ reads no import.meta.env variable",
  envPrefix: "VITE_",
  serving: "builds the app and serves it with `vite preview`",
}
