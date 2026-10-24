# @specrig/vite

[specrig](https://github.com/specrig/specrig-js) for an app built with Vite: the
`runtimeConfig` plugin that serves the app's runtime settings, the checks that
every setting the app reads is answered, the `webServer` helper for
`playwright.config.ts`, and the `specrig` command.

```bash
npx @specrig/vite init --backend api=apiUrl --contract api=../docs/openapi.yaml
```

```bash
npx --no specrig agents
```

rewrites `specrig.md`, Rule #11 for the app, and fails while the app's `AGENTS.md`
does not bring it in.

```bash
npx --no specrig rules
```

prints the app's Rule #11 rules as JSON. `init` names the tool in `specrig.yaml`,
so the specrig plugin for Claude Code reads them and refuses an edit the mode does
not allow:

```
/plugin marketplace add specrig/specrig
/plugin install specrig@specrig
```

It works with
[`@specrig/web`](https://github.com/specrig/specrig-js/tree/main/packages/web).
Usage is in the [repository's README](https://github.com/specrig/specrig-js#readme).

## License

MIT
