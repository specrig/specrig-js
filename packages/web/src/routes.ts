export type Route = { method: string; template: string; segments: string[] }

const param = (segment: string) => segment.startsWith("{") && segment.endsWith("}")

export function route(text: string): Route {
  const [method, template, ...rest] = text.trim().split(/\s+/)
  if (!method || !template?.startsWith("/") || rest.length > 0) {
    throw new Error(`a route is "<METHOD> /path/{param}", not "${text}"`)
  }
  return { method: method.toUpperCase(), template, segments: template.split("/") }
}

export const spell = (r: Route) => `${r.method} ${r.template}`

export function overlap(a: Route, b: Route): boolean {
  return (
    a.method === b.method &&
    a.segments.length === b.segments.length &&
    a.segments.every((s, i) => s === b.segments[i] || param(s) || param(b.segments[i]))
  )
}

export function takes(r: Route, method: string, path: string): boolean {
  const wanted = path.split("/")
  return r.method === method && r.segments.length === wanted.length && r.segments.every((s, i) => param(s) || s === wanted[i])
}

// Of one backend's routes, the one with the most constant segments takes the request, as OpenAPI has it.
export function routeOf(routes: Route[], method: string, path: string): Route | undefined {
  let found: Route | undefined
  let literal = -1
  for (const r of routes) {
    const constant = r.segments.filter((s) => !param(s)).length
    if (takes(r, method, path) && constant > literal) {
      found = r
      literal = constant
    }
  }
  return found
}
