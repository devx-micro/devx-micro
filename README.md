# devx-micro

An [Nx](https://nx.dev) workspace for shared, reusable TypeScript libraries, published under the
`@devx-micro` npm scope.

> **Status:** early. Licensed under [MPL-2.0](https://github.com/devx-micro/devx-micro/blob/main/LICENSE). A secrets scan of the full git history
> (`gitleaks git`) found nothing on 2026-11-17; re-run it before making this repository public.

## Packages

| Package                                                                                                          | What it is                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| [`@devx-micro/cqrs-tool-runtime`](https://github.com/devx-micro/devx-micro/tree/main/libs/cqrs-tool-runtime)     | One dispatch path for a NestJS CQRS app, exposed as a CLI, REPL and JSON-lines sidecar, answering with a uniform result envelope.      |
| [`@devx-micro/cqrs-http-transport`](https://github.com/devx-micro/devx-micro/tree/main/libs/cqrs-http-transport) | Renders that envelope over HTTP: exit code to status mapping, and `unwrap` to a response or `HttpException`.                           |
| [`@devx-micro/observability-port`](https://github.com/devx-micro/devx-micro/tree/main/libs/observability-port)   | The recorder port, observation record shape, content addressing (RFC 8785 + SHA-256) and pure inference-run logic. No storage, no I/O. |

Each package README documents installation, usage and behaviour. The full API reference is generated
with TypeDoc (see [Documentation](#documentation)).

### How they fit together

```
                      ┌─────────────────────────────┐
  CLI / REPL /        │  @devx-micro/cqrs-tool-     │   ToolEnvelope
  sidecar (stdio) ───►│  runtime  (CqrsToolRuntime) │────────────────┐
                      └──────┬──────────────┬───────┘                │
                             │ commands /   │ Recorder (optional)    ▼
                             │ queries      ▼                ┌───────────────────┐
                             ▼       ┌───────────────┐       │ cqrs-http-        │
                      your CommandBus│ observability │       │ transport:        │──► HTTP response
                      and QueryBus   │ -port         │       │ unwrap(envelope)  │
                                     └───────────────┘       └───────────────────┘
```

Dependencies point one way: `cqrs-http-transport` → `cqrs-tool-runtime` → `observability-port`.
See [docs/architecture.md](docs/architecture.md) for the design decisions behind this.

## Getting started

Requirements: Node `>=22.16` (`.tool-versions` pins 24.19.0) and npm.

```bash
npm install
npm run build        # nx run-many -t build
npm test             # vitest, per package
npm run typecheck
npm run lint
npm run format:check
```

Run a single package's task with Nx, e.g. `npx nx test cqrs-tool-runtime` or
`npx nx build observability-port`. `npm run graph` opens the project graph.

### Layout

```
libs/   one package per directory, @devx-micro/<name>
apps/   runnable apps (none yet)
docs/   hand-written docs; docs/api is generated and git-ignored
```

Each library has `src/index.ts` (the public API), `src/lib/*.ts`, colocated `*.spec.ts` files, and
builds with SWC to `dist/libs/<name>`.

## Documentation

| What                          | Where                                           |
| ----------------------------- | ----------------------------------------------- |
| Per-package guides            | `libs/*/README.md`                              |
| Architecture and design rules | [docs/architecture.md](docs/architecture.md)    |
| Contributing                  | [CONTRIBUTING.md](CONTRIBUTING.md)              |
| API reference (TypeDoc)       | `npm run docs`, then open `docs/api/index.html` |

`npm run docs` builds one HTML site covering all three packages, using each package's `README.md`
as its landing page. `npm run docs:check` runs the same validation without writing output, which is
useful in CI.

## Rules

- A package here depends on `@nestjs/*`, `@devx-micro/*` and third-party packages, **never** on
  anything from a consuming repository. A shared library that imports its consumer has become part of it.
- Source, specs, comments and docs carry no names, paths or hosts from any private repository.

## License

[MPL-2.0](https://github.com/devx-micro/devx-micro/blob/main/LICENSE)
