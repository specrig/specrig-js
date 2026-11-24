import { appendFileSync } from "node:fs"

appendFileSync(process.env.BUILD_OUT, "built")
