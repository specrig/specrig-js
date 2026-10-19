import { HttpClient } from "./http-client"

type Item = { name: string }

const api = new HttpClient(import.meta.env.VITE_API_URL)

async function show(root: HTMLElement) {
  const loading = document.createElement("p")
  loading.role = "status"
  loading.textContent = "Loading"
  root.append(loading)
  const items = await api.get<Item[]>("/items")
  loading.remove()
  const heading = document.createElement("h1")
  heading.textContent = import.meta.env.VITE_SHOP_NAME
  const list = document.createElement("ul")
  for (const item of items) {
    const entry = document.createElement("li")
    entry.textContent = item.name
    list.append(entry)
  }
  const help = document.createElement("a")
  help.href = import.meta.env.VITE_HELP_URL
  help.textContent = "Help"
  root.append(heading, list, help)
}

show(document.querySelector("main")!)
