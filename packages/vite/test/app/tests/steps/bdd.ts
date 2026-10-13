import { createBdd } from "playwright-bdd"
import { test } from "../internal/harness"

export const { Given, When, Then } = createBdd(test)
