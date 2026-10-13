import { HttpClient } from "./http-client"

const api = new HttpClient(import.meta.env.VITE_API_URL)

api.get("/items")
