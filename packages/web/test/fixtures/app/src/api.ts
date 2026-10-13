import { httpClient } from "./http-client"

const ENDPOINTS = {
  ITEMS: "/items",
  ITEM: (id: string) => `/items/${id}`,
  LOGOUT: "/account/logout",
}

export const items = () => httpClient.get(ENDPOINTS.ITEMS)

export const item = (id: string) => httpClient.get(ENDPOINTS.ITEM(id))

export const nobodyCalls = (path: string) => httpClient.get(path)

export async function logout(signedIn: boolean): Promise<void> {
  const endpoint = signedIn ? ENDPOINTS.LOGOUT : null
  if (endpoint) {
    await httpClient.delete(endpoint)
  }
}
