# @devx-micro/app-runtime

One dispatch path for a NestJS CQRS application, exposed over every transport a tool needs: a
one-shot **CLI** ([`@devx-micro/app-cli`](https://github.com/devx-micro/devx-micro/tree/main/libs/app-cli)), an interactive **REPL** ([`@devx-micro/app-repl`](https://github.com/devx-micro/devx-micro/tree/main/libs/app-repl)), a newline-delimited JSON
**sidecar** ([`@devx-micro/app-sidecar`](https://github.com/devx-micro/devx-micro/tree/main/libs/app-sidecar)) and **HTTP** ([`@devx-micro/app-http`](https://github.com/devx-micro/devx-micro/tree/main/libs/app-http)).

You describe each operation once, as a `ToolOperationDescriptor`. The runtime validates the input,
builds the command or query, executes it on your `CommandBus` / `QueryBus`, and always answers with
the same **envelope**, whichever transport asked.

The package is deliberately NestJS-light: it depends on `@nestjs/cqrs` types only and talks to your
buses through the structural `ToolBus` interface, so a test double works as well as the real bus.

```bash
npm install @devx-micro/app-runtime
```

## Quick start

```ts
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { runOneShot } from '@devx-micro/app-cli';
import { CqrsToolRuntime, requiredString, type ToolOperationDescriptor } from '@devx-micro/app-runtime';

const operations: ToolOperationDescriptor<{ id: string }>[] = [
  {
    name: 'note.get',
    summary: 'Read one note by id.',
    kind: 'query',
    validate: (input) => ({ id: requiredString(input, 'id') }),
    createRequest: ({ id }) => new GetNoteQuery(id),
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', minLength: 1 } },
      required: ['id'],
    },
  },
];

const runtime = new CqrsToolRuntime({
  commandBus, // a CommandBus, or anything with `execute(request): Promise<unknown>`
  queryBus,
  operations,
});

// One shot, e.g. from `main.ts`:  node main.js --cli note.get --id 42
process.exitCode = await runOneShot(runtime, process.argv.slice(3));

// Or call it programmatically:
const envelope = await runtime.dispatch('note.get', { id: '42' });
```

## Concepts

### Operation descriptors

A `ToolOperationDescriptor` has a `name`, a one-line `summary`, a `kind` (`'command'` or `'query'`,
which selects the bus), and a `createRequest` function that turns validated input into the
command/query object. Optional members:

| Member            | Purpose                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------- |
| `validate`        | Parses raw input into the typed input. Throw `INVALID_INPUT` (see below) to refuse it.  |
| `inputSchema`     | A JSON Schema subset describing the input, for exposing the operation as an agent tool. |
| `observationKind` | Overrides the kind the call is recorded as (default `operation`).                       |
| `recordsItself`   | The handler writes its own completion record, so the runtime records only failures.     |

Registering two operations with the same name throws `DUPLICATE_OPERATION`.

### The envelope

Every dispatch resolves to a `ToolEnvelope` and **never throws**:

```jsonc
{
  "schemaVersion": "1.0.0",
  "correlationId": "…",
  "operation": "note.get",
  "kind": "query",            // "command" | "query" | "system"
  "status": "success",        // "success" | "incomplete" | "error"
  "exitCode": 0,
  "data": { … },              // on success / incomplete
  "error": { "code": "…", "message": "…", "details": … }   // on error
}
```

Branch on `error.code` and `exitCode`, never on message text.

`status` has three values on purpose. A handler that runs a **resumable sequence** returns a payload
containing `complete: boolean` (`ResumableRun`). When that is `false` the envelope is `incomplete`
with exit code `4`: not a failure to diagnose but a stop to **resume**, from the step named in
`data`. A payload with no `complete` key is never treated as incomplete.

### Exit codes

`TOOL_EXIT_CODES`:

| Code | Name             | Meaning                                               |
| ---- | ---------------- | ----------------------------------------------------- |
| 0    | `success`        |                                                       |
| 1    | `failure`        | Unclassified handler failure (`HANDLER_FAILURE`).     |
| 2    | `usage`          | The caller's input was wrong (`INVALID_INPUT`, …).    |
| 3    | `conflict`       |                                                       |
| 4    | `blocked`        | A sequence stopped part-way (`status: "incomplete"`). |
| 5    | `notFound`       |                                                       |
| 10   | `infrastructure` | A backing store or service is unavailable.            |

A domain error that carries its own string `code` (and optionally an integer `exitCode`) keeps both
in the envelope; anything else becomes `HANDLER_FAILURE` at exit `1`. Throw `ToolRuntimeError` to
set them explicitly.

### Input validation

Helpers for `validate` hooks, all of which refuse with `INVALID_INPUT` at exit `2`:
`requiredString`, `optionalString`, `requiredObject`, `optionalObject`, `optionalArray`,
`nonEmptyStringElement`, `parsedNumber`, `parsedWholeNumber`, `invalidInput`.

Two guarantees worth knowing:

- **Unknown keys are refused.** The runtime hands `validate` a probe and records which keys it read;
  any key the caller sent that `validate` never looked at is rejected by name, so a typo cannot
  silently change what a command does.
- **Numbers are parsed, not coerced.** `parsedNumber(true)`, `parsedNumber([])` and
  `parsedNumber(['7'])` are all `null`.

Use `assertInputSchemaAgreesWithValidate(descriptor, validExample)` in a spec to prove a descriptor's
`inputSchema` and its `validate` hook agree (same keys, same required set). It uses only
`node:assert`, so it runs under any test framework.

## Transports

Every transport goes through `CqrsToolRuntime.dispatch`, and each lives in its own package so you
install only the ones your app exposes:

| Transport | Package                                                                                          | Entry point                                    |
| --------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| CLI       | [`@devx-micro/app-cli`](https://github.com/devx-micro/devx-micro/tree/main/libs/app-cli)         | `runOneShot(runtime, args)`                    |
| REPL      | [`@devx-micro/app-repl`](https://github.com/devx-micro/devx-micro/tree/main/libs/app-repl)       | `runInteractiveRepl(runtime)`                  |
| Sidecar   | [`@devx-micro/app-sidecar`](https://github.com/devx-micro/devx-micro/tree/main/libs/app-sidecar) | `runJsonLinesDriver(runtime)`, `SidecarClient` |
| HTTP      | [`@devx-micro/app-http`](https://github.com/devx-micro/devx-micro/tree/main/libs/app-http)       | `unwrap(envelope)`                             |

## Recording what was dispatched

Pass a `Recorder` from [`@devx-micro/app-observability`](https://github.com/devx-micro/devx-micro/tree/main/libs/app-observability) to observe every
dispatch of a registered operation:

```ts
new CqrsToolRuntime({ commandBus, queryBus, operations, recorder, operator: 'my-tool' });
```

- **Recording never changes the result.** Recorder, clock and mapping errors are swallowed.
- **No argument values are recorded**: only the key names (at most 32, each cut to 64 characters)
  and, on failure, the error _code_.
- A recorder that hangs cannot hold up the answer: the runtime waits `recordTimeoutMs` (default
  2000), then stops asking for `recordCooldownMs` (default 30000).
- Unknown operation names are not recorded.

## API reference

Generated TypeDoc: run `npm run docs` at the repository root and open `docs/api/index.html`.

## License

[MPL-2.0](https://github.com/devx-micro/devx-micro/blob/main/LICENSE)
