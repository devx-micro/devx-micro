# @devx-micro/app-main

The process entry point for a [`@devx-micro/app-runtime`](https://github.com/devx-micro/devx-micro/tree/main/libs/app-runtime) application. Every such application starts the same four ways — a one-shot CLI, a REPL, a JSON-lines sidecar and an HTTP API — and chooses between them from `argv`. `defineApp` builds those entry points and that choice, so an application's `main.ts` states only what is its own.

## Install

```bash
npm install @devx-micro/app-main
```

It composes [`app-cli`](https://github.com/devx-micro/devx-micro/tree/main/libs/app-cli), [`app-repl`](https://github.com/devx-micro/devx-micro/tree/main/libs/app-repl) and [`app-sidecar`](https://github.com/devx-micro/devx-micro/tree/main/libs/app-sidecar). It is not a transport itself, so those packages still do not depend on each other. It needs `@nestjs/common` for `INestApplication` and `Logger`; it never creates the Nest application, so it does not need `@nestjs/core`.

## Usage

```ts
import { defineApp } from '@devx-micro/app-main';

const app = defineApp({
  name: 'schedule',
  createTool: createScheduleTool, // (options?) => Promise<{ runtime, close }>
  http: {
    createApp: createScheduleHttp, // (options?) => Promise<INestApplication>, not yet listening
    portEnv: 'SCHEDULE_PORT',
    defaultPort: 3401,
  },
  isOperatorError: (error) => error instanceof WorkspaceError,
});

// The in-process entry points, for tests and for other code that embeds the app.
export const { runCli, runRepl, runSidecar, runApi } = app;

if (require.main === module) void app.main();
```

### What `main` does

| `argv`                         | Mode                              |
| ------------------------------ | --------------------------------- |
| an unrecognised `--flag` first | refused by name, exit code 2      |
| contains `--repl`              | REPL                              |
| contains `--sidecar`           | JSON-lines sidecar                |
| contains an extra mode's flag  | that mode                         |
| empty                          | HTTP API (the help text if none)  |
| anything else                  | one-shot CLI (`--cli` is ignored) |

An unrecognised `--flag` is refused rather than falling through, because otherwise a typo such as `--repel` would reach the "no arguments" case and start a web server.

`main` sets `process.exitCode` and never calls `process.exit`, so a running server keeps the process alive and open handles drain.

### Operator errors

`isOperatorError` marks failures that are the operator's to fix (a missing workspace, a bad config). They print their message alone and exit 1. Any other error prints `<name> failed:` with a stack in one-shot mode, and is rethrown by the long-running modes so it is not swallowed.

### HTTP

`http.createApp` builds the Nest application, because only the application knows its module and `NestFactory` options. `defineApp` then sets the global prefix (`api` unless `globalPrefix` says otherwise), runs `http.configure` for CORS, body parsers and workers, and listens on `process.env[portEnv] || defaultPort`.

### Extra modes

```ts
defineApp({
  // …
  extraModes: [{ flag: '--hub', run: (options) => startHub(options) }],
});
```

An extra mode is named in the unknown-mode message and handled like the REPL and the sidecar.
