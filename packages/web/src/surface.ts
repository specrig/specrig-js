import path from "node:path"
import ts from "typescript"
import type { Config } from "./config.js"

const verbs: Record<string, string> = { get: "GET", post: "POST", put: "PUT", patch: "PATCH", delete: "DELETE" }
const deepest = 12
const uncalled = "\u0000"
const compilerConfigs = ["tsconfig.app.json", "tsconfig.json", "jsconfig.json"]

type Fn = ts.FunctionLikeDeclaration
type Bindings = Map<ts.ParameterDeclaration, string[]>

// The requests the app's client can send, by the client that sends them: one
// client, one base URL, so its requests all go to one backend.
export function extract(config: Config): Map<string, string[]> {
  const root = config.root
  const sourceDir = path.join(root, config.surface.sources ?? "src")
  const names = config.surface.tsconfig ? [config.surface.tsconfig] : compilerConfigs
  const compilerConfig = names.map((name) => path.join(root, name)).find((file) => ts.sys.fileExists(file))
  if (!compilerConfig) {
    throw new Error(`surface: ${root} has no ${names.join(" or ")} to read the code through`)
  }
  const read = ts.readConfigFile(compilerConfig, ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root, undefined, compilerConfig)
  const program = ts.createProgram(parsed.fileNames, parsed.options)
  const checker = program.getTypeChecker()
  const sources = program.getSourceFiles().filter((f) => !f.isDeclarationFile && f.fileName.startsWith(sourceDir))
  if (sources.length === 0) {
    throw new Error(`surface: ${path.basename(compilerConfig)} takes in no file under ${path.relative(root, sourceDir)}/`)
  }

  const calls: ts.CallExpression[] = []
  const callers = new Map<Fn, ts.CallExpression[]>()
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      calls.push(node)
      const fn = functionOf(declarationOf(node.expression))
      if (fn) {
        callers.set(fn, [...(callers.get(fn) ?? []), node])
      }
    }
    ts.forEachChild(node, visit)
  }
  sources.forEach(visit)

  function declarationOf(expr: ts.Expression): ts.Declaration | undefined {
    let symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(expr) ? expr.name : expr)
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
      symbol = checker.getAliasedSymbol(symbol)
    }
    return symbol?.valueDeclaration ?? symbol?.declarations?.[0]
  }

  function functionOf(decl: ts.Declaration | undefined, depth = 0): Fn | undefined {
    if (!decl || depth > deepest) {
      return undefined
    }
    if ((ts.isVariableDeclaration(decl) || ts.isPropertyAssignment(decl)) && decl.initializer) {
      const init = decl.initializer
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
        return init
      }
      return ts.isIdentifier(init) || ts.isPropertyAccessExpression(init) ? functionOf(declarationOf(init), depth + 1) : undefined
    }
    return ts.isFunctionDeclaration(decl) || ts.isMethodDeclaration(decl) ? decl : undefined
  }

  function returned(fn: Fn): ts.Expression[] {
    if (!fn.body) {
      return []
    }
    if (!ts.isBlock(fn.body)) {
      return [fn.body]
    }
    const out: ts.Expression[] = []
    const walk = (node: ts.Node) => {
      if (ts.isReturnStatement(node) && node.expression) {
        out.push(node.expression)
      } else if (!ts.isFunctionLike(node)) {
        ts.forEachChild(node, walk)
      }
    }
    ts.forEachChild(fn.body, walk)
    return out
  }

  function product(a: string[], b: string[]): string[] {
    return a.flatMap((x) => b.map((y) => x + y))
  }

  // A parameter is what its callers pass. With none, a whole path made of it is a
  // wrapper nobody calls, and requests nothing; a segment made of it varies.
  function templates(expr: ts.Expression, bound: Bindings, depth: number): string[] {
    if (depth > deepest) {
      return ["{}"]
    }
    const next = (e: ts.Expression, b: Bindings = bound) => templates(e, b, depth + 1)

    if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isNonNullExpression(expr)) {
      return next(expr.expression)
    }
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
      return [expr.text]
    }
    if (expr.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(expr) && expr.text === "undefined")) {
      return []
    }
    if (ts.isTemplateExpression(expr)) {
      let out = [expr.head.text]
      for (const span of expr.templateSpans) {
        out = product(product(out, next(span.expression)), [span.literal.text])
      }
      return out
    }
    if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return product(next(expr.left), next(expr.right))
    }
    if (ts.isConditionalExpression(expr)) {
      return [...next(expr.whenTrue), ...next(expr.whenFalse)]
    }
    if (ts.isCallExpression(expr)) {
      const fn = functionOf(declarationOf(expr.expression))
      if (!fn) {
        return ["{}"]
      }
      const inner: Bindings = new Map()
      fn.parameters.forEach((p, i) => inner.set(p, expr.arguments[i] ? next(expr.arguments[i]) : ["{}"]))
      return returned(fn).flatMap((r) => next(r, inner))
    }
    if (ts.isIdentifier(expr) || ts.isPropertyAccessExpression(expr)) {
      const decl = declarationOf(expr)
      if (decl && ts.isParameter(decl)) {
        const given = bound.get(decl)
        if (given) {
          return given
        }
        const fn = decl.parent as Fn
        const index = fn.parameters.indexOf(decl)
        const calls = callers.get(fn) ?? []
        if (calls.length === 0) {
          return [uncalled]
        }
        return calls.flatMap((call) => (call.arguments[index] ? next(call.arguments[index], new Map()) : ["{}"]))
      }
      if (decl && (ts.isVariableDeclaration(decl) || ts.isPropertyAssignment(decl)) && decl.initializer) {
        return next(decl.initializer)
      }
    }
    return ["{}"]
  }

  function sink(call: ts.CallExpression): string | undefined {
    if (!ts.isPropertyAccessExpression(call.expression)) {
      return undefined
    }
    const verb = verbs[call.expression.name.text]
    const owner = declarationOf(call.expression)?.parent
    return verb && owner && ts.isClassDeclaration(owner) && owner.name?.text === config.surface.client ? verb : undefined
  }

  function clientOf(call: ts.CallExpression, where: string): string {
    const decl = declarationOf((call.expression as ts.PropertyAccessExpression).expression)
    if (!decl || !(ts.isVariableDeclaration(decl) || ts.isPropertyDeclaration(decl)) || !ts.isIdentifier(decl.name)) {
      throw new Error(`${where}: a request through a client held nowhere a name can point at`)
    }
    const file = path.relative(sourceDir, decl.getSourceFile().fileName).replace(/\.[cm]?[jt]sx?$/, "")
    const owner = ts.isPropertyDeclaration(decl) && ts.isClassDeclaration(decl.parent) ? `${decl.parent.name?.text}.` : ""
    return `${file}.${owner}${decl.name.text}`
  }

  const found = new Map<string, Set<string>>()
  for (const call of calls) {
    const verb = sink(call)
    if (!verb || call.arguments.length === 0) {
      continue
    }
    const where = `${path.relative(root, call.getSourceFile().fileName)}:${call.getSourceFile().getLineAndCharacterOfPosition(call.getStart()).line + 1}`
    for (const t of templates(call.arguments[0], new Map(), 0)) {
      if (t.startsWith(uncalled)) {
        continue
      }
      const client = clientOf(call, where)
      found.set(client, (found.get(client) ?? new Set()).add(`${verb} ${pathOf(t.replaceAll(uncalled, "{}"), where)}`))
    }
  }
  return new Map([...found].sort(([a], [b]) => (a < b ? -1 : 1)).map(([client, requests]) => [client, [...requests].sort()]))
}

function pathOf(template: string, where: string): string {
  const [route] = template.split("?")
  if (!route.startsWith("/")) {
    throw new Error(`${where}: a request whose path is not a constant ("${template}") has no name to record`)
  }
  return route
    .split("/")
    .map((segment) => (segment.includes("{}") ? "{}" : segment))
    .join("/")
}

export function encode(service: string, clients: Map<string, string[]>): string {
  return [
    "# Generated from the code by specrig; the suite fails when it falls behind.",
    "version: 1",
    `service: ${service}`,
    "clients:",
    ...[...clients].flatMap(([client, requests]) => [`  ${client}:`, ...requests.map((r) => `    - ${r}`)]),
    "",
  ].join("\n")
}
