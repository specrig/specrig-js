import { expect } from "@playwright/test"
import { Given, Then, When } from "./bdd"

Given("the shop sells {string} and {string}", async ({ edges }, first: string, second: string) => {
  edges.api.reply("GET", "/items", 200, [{ name: first }, { name: second }])
})

When("the visitor opens the shop", async ({ page }) => {
  await page.goto("/")
})

When("they click {string}", async ({ page }, name: string) => {
  await page.getByRole("link", { name }).click()
})

Then("they see {string} and {string} under {string}", async ({ page }, first: string, second: string, name: string) => {
  await expect(page.getByRole("heading", { name })).toBeVisible()
  await expect(page.getByRole("listitem")).toHaveText([first, second])
})

Then("they are sent to the help pages", async ({ edges }) => {
  await expect.poll(() => edges.visited.map(String)).toEqual(["https://help.shop.test/"])
})
