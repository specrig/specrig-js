import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import ts from "typescript"

const builtin = ["MODE", "DEV", "PROD", "BASE_URL", "SSR"]

function isEnv(node: ts.Node): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "env" &&
    ts.isMetaProperty(node.expression) &&
    node.expression.keywordToken === ts.SyntaxKind.ImportKeyword
  )
}

export function envRead(dir: string): string[] {
  if (!existsSync(dir)) {
    return []
  }
  const found = new Set<string>()
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAccessExpression(node) && isEnv(node.expression)) {
      found.add(node.name.text)
    } else if (ts.isElementAccessExpression(node) && isEnv(node.expression) && ts.isStringLiteralLike(node.argumentExpression)) {
      found.add(node.argumentExpression.text)
    }
    ts.forEachChild(node, visit)
  }
  for (const file of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    if (/\.[cm]?[jt]sx?$/.test(file) && !file.endsWith(".d.ts")) {
      const full = path.join(dir, file)
      visit(ts.createSourceFile(full, readFileSync(full, "utf8"), ts.ScriptTarget.Latest, true))
    }
  }
  return [...found].filter((name) => !builtin.includes(name)).sort()
}
