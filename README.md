# DocCloak.Core

`@doccloak/core` is the UI-free document anonymization engine of the DocCloak
ecosystem: detection (ONNX NER providers, regex rules), session state,
placeholder mapping, document parsing, and a transport-agnostic worker
protocol.

## Ecosystem split

| Repository | License | Role |
| --- | --- | --- |
| DocCloak.Core (this repo) | Apache-2.0 | The `@doccloak/core` engine package, consumed by every shell |
| DocCloak (web app) | AGPL-3.0 | Open-source web UI that consumes `@doccloak/core` |
| DocCloak browser extension | proprietary | Closed-source MV3 extension, also built on `@doccloak/core` |

The engine is permissively licensed (Apache-2.0) so both the AGPL web app and
the proprietary extension can depend on it.

## Status

Early scaffold. The package currently ships TypeScript source directly
(`main`/`types` point at `./src/index.ts`); a build step arrives with the
first npm publish. Engine code is being extracted from the web app in stages,
so the export surface (`.`, `./dom`, `./worker-protocol`) is mostly
placeholders for now.

## Development

```sh
npm install
npm test        # vitest
npm run typecheck
```

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
