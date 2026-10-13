import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import ts from "typescript"

// Vite's DEFAULT_CONFIG_FILES, in its order; it does not export them.
const viteConfigs = ["vite.config.js", "vite.config.mjs", "vite.config.ts", "vite.config.cjs", "vite.config.mts", "vite.config.cts"]

export function viteConfig(app: string): string | undefined {
  return viteConfigs.map((name) => path.join(app, name)).find((file) => existsSync(file))
}

// Read from the map handed to runtimeConfig(...), since init has no server to ask.
export function runtimeFields(file: string): string[] | undefined {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true)
  let fields: string[] | undefined
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "runtimeConfig" &&
      node.arguments[0] &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      fields = node.arguments[0].properties
        .map((p) => (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : undefined))
        .filter((name): name is string => name !== undefined)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return fields
}
