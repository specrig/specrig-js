import { readFileSync } from "node:fs"
import path from "node:path"
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js"
import addFormats from "ajv-formats"
import YAML from "yaml"

type Operation = {
  requestBody?: { content?: Record<string, { schema?: unknown }> }
  responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>
}

// What a stand-in may answer and what the app may send, by the backend's OpenAPI document.
export class Contract {
  private paths: Record<string, Record<string, Operation>>
  private ajv: Ajv2020
  private compiled = new Map<string, ValidateFunction>()
  private id: string

  // failure names the schema of a 5xx, which a backend may answer on any route.
  constructor(
    file: string,
    private readonly backend: string,
    private readonly failure?: string,
  ) {
    const doc = YAML.parse(readFileSync(file, "utf8"))
    this.id = path.basename(file)
    this.paths = doc.paths
    this.ajv = new Ajv2020({ strict: false, allErrors: true })
    addFormats(this.ajv)
    this.ajv.addSchema({ ...doc, $id: this.id })
  }

  private pointer(...parts: string[]): string {
    return `${this.id}#/${parts.map((p) => p.replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`
  }

  // The template with the most constant segments wins: /customers/contracts/unit over /customers/contracts/{contractId}.
  private template(method: string, requestPath: string): string | undefined {
    const wanted = requestPath.split("/")
    let best: { template: string; literal: number } | undefined
    for (const [template, operations] of Object.entries(this.paths)) {
      const segments = template.split("/")
      if (!operations[method] || segments.length !== wanted.length) {
        continue
      }
      if (!segments.every((s, i) => s.startsWith("{") || s === wanted[i])) {
        continue
      }
      const literal = segments.filter((s) => !s.startsWith("{")).length
      if (!best || literal > best.literal) {
        best = { template, literal }
      }
    }
    return best?.template
  }

  // A request is named as the route that takes it, so that it meets the backend's input of the same name.
  name(method: string, requestPath: string): string {
    return `${method} ${this.template(method.toLowerCase(), requestPath) ?? requestPath}`
  }

  private validate(ref: string, value: unknown): string[] {
    let check = this.compiled.get(ref)
    if (!check) {
      check = this.ajv.compile({ $ref: ref })
      this.compiled.set(ref, check)
    }
    return check(value) ? [] : (check.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`)
  }

  request(method: string, requestPath: string, body: unknown): string[] {
    const verb = method.toLowerCase()
    const template = this.template(verb, requestPath)
    const operation = template && this.paths[template][verb]
    if (!template || !operation) {
      return [`${method} ${requestPath}: ${this.backend} serves no such route`]
    }
    if (body === undefined || !operation.requestBody?.content?.["application/json"]?.schema) {
      return []
    }
    return this.validate(this.pointer("paths", template, verb, "requestBody", "content", "application/json", "schema"), body).map(
      (e) => `${method} ${requestPath} request body: ${e}`,
    )
  }

  response(method: string, requestPath: string, status: number, body: unknown): string[] {
    const verb = method.toLowerCase()
    const template = this.template(verb, requestPath)
    const operation = template && this.paths[template][verb]
    if (!template || !operation) {
      return []
    }
    const where = `${method} ${requestPath} answered ${status}`
    const documented = operation.responses?.[String(status)]
    if (!documented) {
      if (status >= 500 && this.failure) {
        return this.validate(this.pointer("components", "schemas", this.failure), body).map((e) => `${where}: ${e}`)
      }
      return [`${where}: ${this.backend} does not answer ${status} here`]
    }
    if (!documented.content?.["application/json"]?.schema) {
      return []
    }
    return this.validate(this.pointer("paths", template, verb, "responses", String(status), "content", "application/json", "schema"), body).map(
      (e) => `${where}: ${e}`,
    )
  }
}
