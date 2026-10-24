# @specrig/web

The core of [specrig](https://github.com/specrig/specrig-js), independent of the
build tool: a Playwright harness that stands in for a web app's backends by their
OpenAPI contract, the records of what the app can request and what its cases make
it send, the engine behind `specrig init`, and `specrig rules`, which prints the
app's Rule #11 rules — what the specrig plugin for Claude Code checks every edit
against.

It carries a pinned copy of [specrig's protocol](https://github.com/specrig/protocol)
data in `protocol/`: the modes `rules` reads and the parts of `specrig.md`.

An app uses it with the adapter for its build tool — for Vite,
[`@specrig/vite`](https://github.com/specrig/specrig-js/tree/main/packages/vite).
Usage is in the [repository's README](https://github.com/specrig/specrig-js#readme).

## License

MIT
