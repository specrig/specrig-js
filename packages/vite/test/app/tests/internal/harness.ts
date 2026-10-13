import { type Edges as EdgesOf, harness } from "@specrig/web"
import config from "../../harness.config"

export const { test } = harness(config)

export type Edges = EdgesOf<typeof config>
