export class HttpClient {
  private readonly base: string

  constructor(base: string) {
    this.base = base
  }

  async get<T>(path: string): Promise<T> {
    const response = await fetch(this.base + path)
    if (!response.ok) {
      throw new Error(`${path} answered ${response.status}`)
    }
    return (await response.json()) as T
  }
}
