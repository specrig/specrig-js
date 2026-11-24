type Line = Array<[column: number, source: number]>
type Decoded = { sources: string[]; lines: Line[] }

const digits = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
const value = new Map([...digits].map((digit, i) => [digit, i]))

function vlq(segment: string): number[] {
  const out: number[] = []
  let shift = 0
  let accumulated = 0
  for (const digit of segment) {
    const bits = value.get(digit)
    if (bits === undefined) {
      return out
    }
    accumulated += (bits & 31) << shift
    if (bits & 32) {
      shift += 5
      continue
    }
    out.push(accumulated & 1 ? -(accumulated >>> 1) : accumulated >>> 1)
    shift = 0
    accumulated = 0
  }
  return out
}

export function decode(map: { sources: string[]; sourceRoot?: string; mappings: string }): Decoded {
  const root = map.sourceRoot ? `${map.sourceRoot.replace(/\/$/, "")}/` : ""
  const lines: Line[] = []
  let source = 0
  for (const text of map.mappings.split(";")) {
    const line: Line = []
    let column = 0
    for (const segment of text.split(",")) {
      if (segment === "") {
        continue
      }
      const fields = vlq(segment)
      column += fields[0] ?? 0
      if (fields.length >= 4) {
        source += fields[1]
        line.push([column, source])
      }
    }
    lines.push(line)
  }
  return { sources: map.sources.map((s) => root + s), lines }
}

export function sourceAt(decoded: Decoded, line: number, column: number): string | undefined {
  let found: number | undefined
  for (const [start, source] of decoded.lines[line - 1] ?? []) {
    if (start > column - 1) {
      break
    }
    found = source
  }
  return found === undefined ? undefined : decoded.sources[found]
}

export function packageOf(source: string): string | undefined {
  const at = source.lastIndexOf("node_modules/")
  if (at < 0) {
    return undefined
  }
  const [first, second] = source.slice(at + "node_modules/".length).split("/")
  return first.startsWith("@") && second ? `${first}/${second}` : first
}

export class Sources {
  private maps = new Map<string, Promise<Decoded | undefined>>()

  async packageAt(place: string): Promise<string | undefined> {
    const parts = place.match(/^(.*):(\d+):(\d+)$/)
    if (!parts) {
      return undefined
    }
    const [, script, line, column] = parts
    const decoded = await this.map(script)
    const source = decoded && sourceAt(decoded, Number(line), Number(column))
    return source ? packageOf(source) : undefined
  }

  private map(script: string): Promise<Decoded | undefined> {
    let map = this.maps.get(script)
    if (!map) {
      map = load(script).catch(() => undefined)
      this.maps.set(script, map)
    }
    return map
  }
}

async function load(script: string): Promise<Decoded | undefined> {
  const code = await (await fetch(script)).text()
  const comment = [...code.matchAll(/\/\/[#@] sourceMappingURL=(\S+)/g)].pop()?.[1]
  if (!comment) {
    return undefined
  }
  const url = new URL(comment, script)
  const json =
    url.protocol === "data:"
      ? Buffer.from(url.pathname.slice(url.pathname.indexOf(",") + 1), url.pathname.includes(";base64,") ? "base64" : "utf8").toString("utf8")
      : await (await fetch(url)).text()
  return decode(JSON.parse(json))
}
