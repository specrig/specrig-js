import path from "node:path"

export type BackendConfig = {
  origin: string
  field?: string
  env?: string
  contract?: string
  failure?: string
}

export type PageConfig = {
  origin: string
  field?: string
  env?: string
}

export type Config = {
  root: string
  service: string
  features?: string
  runtime?: {
    path: string
    global: string
    constants?: Record<string, unknown>
  }
  build?: {
    constants?: Record<string, string>
  }
  backends: Record<string, BackendConfig>
  pages?: Record<string, PageConfig>
  assets?: Record<string, { origin: string }>
  surface: { client: string; tsconfig?: string; sources?: string }
}

const reserved = ["visited", "trace"]

export function defineConfig<const C extends Config>(config: C): C {
  for (const name of Object.keys(config.backends)) {
    if (reserved.includes(name)) {
      throw new Error(`harness config: a backend cannot be named ${name}, the edges already hold one`)
    }
  }
  return config
}

export type Origins<C extends Config> = Record<
  keyof C["backends"] | keyof NonNullable<C["pages"]> | keyof NonNullable<C["assets"]>,
  string
>

export function origins<const C extends Config>(config: C): Origins<C> {
  const all = { ...config.backends, ...config.pages, ...config.assets }
  return Object.fromEntries(Object.entries(all).map(([name, edge]) => [name, edge.origin])) as Origins<C>
}

function pointing(config: Config, by: "field" | "env"): [string, string][] {
  return Object.values({ ...config.backends, ...config.pages }).flatMap((edge) => (edge[by] ? [[edge[by], edge.origin]] : []))
}

export function runtimeValues(config: Config): Record<string, unknown> {
  return { ...Object.fromEntries(pointing(config, "field")), ...config.runtime?.constants }
}

export function buildEnv(config: Config): Record<string, string> {
  return { ...Object.fromEntries(pointing(config, "env")), ...config.build?.constants }
}

export function coverage(answered: string[], read: string[]): { missing: string[]; unknown: string[] } {
  return {
    missing: read.filter((name) => !answered.includes(name)),
    unknown: answered.filter((name) => !read.includes(name)),
  }
}

export function resolve(config: Config, file: string): string {
  return path.resolve(config.root, file)
}

export function runtimeScript(config: Config): string | undefined {
  return config.runtime && `window.${config.runtime.global} = ${JSON.stringify(runtimeValues(config))}`
}
