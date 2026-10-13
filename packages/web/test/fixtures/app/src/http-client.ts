export class HttpClient {
  get<T>(path: string): Promise<T> {
    return fetch(path).then((r) => r.json())
  }

  delete(path: string): Promise<void> {
    return fetch(path, { method: "DELETE" }).then(() => undefined)
  }
}

export const httpClient = new HttpClient()
