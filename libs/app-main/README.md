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

if (require.main === module) {
  // An error that is not an operator error is rethrown from the long-running modes, as a bug should
  // be. Without this catch it becomes an unhandled rejection: Node prints the stack and exits 1.
  app.main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
```

### What `main` does

| `argv`                        | Mode                              |
| ----------------------------- | --------------------------------- |
| an unrecognised flag first    | refused by name, exit code 2      |
| contains `--repl`             | REPL                              |
| contains `--sidecar`          | JSON-lines sidecar                |
| contains an extra mode's flag | that mode                         |
| empty                         | HTTP API (the help text if none)  |
| anything else                 | one-shot CLI (`--cli` is ignored) |

An unrecognised leading flag is refused rather than falling through — `--repel` and `-x` alike — because otherwise a typo would reach the "no arguments" case and start a web server, or be run as an operation called `-x`. An operation name never starts with `-`, so nothing legitimate is refused. The standard flags `--cli`, `--help` and `-h` are accepted and run as a one-shot request.

`main` sets `process.exitCode` and never calls `process.exit`, so a running server keeps the process alive and open handles drain.

### Operator errors

`isOperatorError` marks failures that are the operator's to fix (a missing workspace, a bad config). They print their message alone and exit 1. Any other error prints `<name> failed:` with a stack in one-shot mode, and is rethrown by the long-running modes so it is not swallowed.

### HTTP

`http.createApp(options, { port })` builds the Nest application, because only the application knows its module and `NestFactory` options. The port (`process.env[portEnv] || defaultPort`) is resolved first and handed to `createApp` and `configure`, for an application that needs it before it starts, such as to build its own public URL. `defineApp` then sets the global prefix (`api` unless `globalPrefix` says otherwise), runs `http.configure(app, options, { port })` for CORS, body parsers and workers, and listens.

If `configure` or `listen` throws, the application is closed and the original error is rethrown, so a half-started app does not keep timers or sockets alive.

### Extra modes

```ts
defineApp({
  // …
  extraModes: [{ flag: '--hub', run: (options, argv) => startHub(options, argv) }],
});
```

An extra mode receives the options and the full `argv`, so it can parse flags of its own. It is named in the unknown-mode message and handled like the REPL and the sidecar: an operator error prints its message and exits 1, anything else is rethrown. A mode that needs another exit code sets `process.exitCode` itself. A flag that repeats a standard flag, or another extra mode's, makes `defineApp` throw when the app is defined.
