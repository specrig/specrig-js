export class HttpClient {
  constructor(base) {
    this.base = base
  }

  async get(path) {
    return (await fetch(this.base + path)).json()
  }
}
