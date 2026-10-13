import { type Connect, loadEnv, type Plugin } from "vite"

// The one list of runtime settings: dev and preview serve them from .env, and the
// build leaves a template the image fills from its environment at start.
export function runtimeConfig(
  fields: Record<string, string>,
  { path = "/config.js", global = "__CONFIG__" }: { path?: string; global?: string } = {},
): Plugin {
  const script = (value: (name: string) => string) =>
    `window.${global} = ${JSON.stringify(Object.fromEntries(Object.entries(fields).map(([field, name]) => [field, value(name)])))}\n`
  let body = ""
  const serve: Connect.NextHandleFunction = (req, res, next) => {
    if (req.url?.split("?")[0] !== path) {
      next()
      return
    }
    res.setHeader("Content-Type", "application/javascript")
    res.setHeader("Cache-Control", "no-store")
    res.end(body)
  }
  return {
    name: "specrig:runtime-config",
    configResolved(config) {
      const env = loadEnv(config.mode, config.envDir || config.root, "")
      body = script((name) => env[name] ?? "")
    },
    configureServer(server) {
      server.middlewares.use(serve)
    },
    configurePreviewServer(server) {
      server.middlewares.use(serve)
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: `${path.slice(1)}.template`, source: script((name) => `\${${name}}`) })
    },
  }
}
