import { defineConfig } from "@specrig/web"

// Every origin a scenario stands in for; a request to any other fails the test.
export default defineConfig({
  root: import.meta.dirname,
  service: "shop",
  build: { constants: { VITE_SHOP_NAME: "Corner shop" } },
  backends: {
    api: {
      origin: "https://api.shop.test",
      env: "VITE_API_URL",
    },
  },
  pages: {
    help: { origin: "https://help.shop.test", env: "VITE_HELP_URL" },
  },
  surface: { client: "HttpClient" },
})
