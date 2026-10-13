import type { Frame, Request } from "@playwright/test"
import type { Traced } from "./flows.js"

// What the app sends after an action belongs to it until the next action or set-up:
// a page answers a click later than the step that clicked returns.
export class Trace {
  readonly records: Traced[] = []
  scenario?: { feature: string; scenario: string }
  private step = ""
  private pending = new Set<Request>()
  private lastActivity = 0

  started(request: Request): void {
    this.pending.add(request)
    this.lastActivity = Date.now()
  }

  finished(request: Request): void {
    this.pending.delete(request)
    this.lastActivity = Date.now()
  }

  // A frame's new document ends what the old one had in flight, and no event says so.
  navigated(frame: Frame): void {
    for (const request of this.pending) {
      if (request.frame() === frame) {
        this.pending.delete(request)
      }
    }
  }

  act(type: string, text: string): void {
    if (type !== "Outcome") {
      this.step = type
    }
    if (type === "Action") {
      this.records.push({ seq: this.records.length, dir: "in", kind: "ui", name: text, step: type })
    }
  }

  sent(route: string, body: unknown): void {
    this.records.push({ seq: this.records.length, dir: "out", kind: "http", name: route, body, step: this.step })
  }

  // A click returns before the page sends what it caused, so after an action the quiet is counted from now too.
  async settle(): Promise<void> {
    const since = this.step === "Action" ? Date.now() : 0
    const deadline = Date.now() + 5000
    const quiet = () => Date.now() - Math.max(this.lastActivity, since) >= 250
    while ((this.pending.size > 0 || !quiet()) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
}
