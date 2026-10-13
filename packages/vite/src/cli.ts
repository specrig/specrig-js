#!/usr/bin/env node
import { main } from "@specrig/web/cli"
import { preset } from "./preset.js"

process.exit(main(process.argv.slice(2), preset))
