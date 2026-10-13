# @specrig/web

The core of [specrig](https://github.com/specrig/specrig-js), independent of the
build tool: a Playwright harness that stands in for a web app's backends by their
OpenAPI contract, the records of what the app can request and what its cases make
it send, and the engine behind `specrig init`.

An app uses it with the adapter for its build tool — for Vite,
[`@specrig/vite`](https://github.com/specrig/specrig-js/tree/main/packages/vite).
Usage is in the [repository's README](https://github.com/specrig/specrig-js#readme).

## License

MIT
