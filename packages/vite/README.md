# @specrig/vite

[specrig](https://github.com/specrig/specrig-js) for an app built with Vite: the
`runtimeConfig` plugin that serves the app's runtime settings, the checks that
every setting the app reads is answered, the `webServer` helper for
`playwright.config.ts`, and the `specrig` command.

```bash
npx @specrig/vite init --backend api=apiUrl --contract api=../docs/openapi.yaml
```

It works with
[`@specrig/web`](https://github.com/specrig/specrig-js/tree/main/packages/web).
Usage is in the [repository's README](https://github.com/specrig/specrig-js#readme).

## License

MIT
