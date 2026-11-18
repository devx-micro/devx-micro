# @devx-micro/cqrs-tool-runtime

One dispatch path for a NestJS CQRS application, exposed over every transport a tool needs: a
one-shot **CLI**, an interactive **REPL**, a newline-delimited JSON **sidecar**, and (with
[`@devx-micro/cqrs-http-transport`](https://github.com/devx-micro/devx-micro/tree/main/libs/cqrs-http-transport)) **HTTP**.

You describe each operation once, as a `ToolOperationDescriptor`. The runtime validates the input,
builds the command or query, executes it on your `CommandBus` / `QueryBus`, and always answers with
the same **envelope**, whichever transport asked.

The package is deliberately NestJS-light: it depends on `@nestjs/cqrs` types only and talks to your
buses through the structural `ToolBus` interface, so a test double works as well as the real bus.

```bash
npm install @devx-micro/cqrs-tool-runtime
```

## Quick start

```ts
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { CqrsToolRuntime, requiredString, runOneShot, type ToolOperationDescriptor } from '@devx-micro/cqrs-tool-runtime';

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

All four go through `CqrsToolRuntime.dispatch`.

### CLI: `runOneShot(runtime, args)`

```bash
tool note.get --id 42
tool note.create --json '{"title":"hi"}'
tool note.create --json-file ./payload.json
tool --help
tool help note.get
```

- `--key value` sets a string; a bare `--flag` sets `true`.
- A repeated key **accumulates** into an array, in order, across flags, `--json` and `--json-file`.
- `--json` takes an object inline; `--json-file` reads it from disk (a leading BOM is stripped).
  Prefer the file when the payload contains quotes or backticks your shell would mangle.
- Prints one envelope as JSON on stdout and resolves to the exit code to use.
- Argument errors are reported as an envelope with operation `parse` and exit code `2`.

### Sidecar: `runJsonLinesDriver(runtime, input?, output?)`

Reads one JSON request per line, writes one envelope per line. Intended for editor extensions and
other parent processes.

```jsonc
{"operation":"note.get","input":{"id":"42"},"correlationId":"abc"}
{"operation":"help","input":{"topic":"note.get"}}
```

A line that is not valid JSON yields an `INVALID_JSON_LINE` envelope; the loop continues.

### REPL: `runInteractiveRepl(runtime, input?, output?)`

An interactive prompt with tab completion, `help [operation]`, and `exit` / `quit`. Each line may be
flags (`note.get --id 42`) or a JSON request. Every line is dispatched with the correlation id
`<sessionId>.<n>`, so one sitting can be grouped.

If you bind a `SessionBoardPort` (see the `sessionBoard` option), the REPL also supports
**session variables**:

```
tool> set $n = note.get --id 42
tool> note.update --id $n.id --title "renamed"
tool> vars
tool> board save my-session
```

References are `$name`, `$name.field`, `$name[0]`; write `$$` for a literal `$`. A resolved value is
substituted as exactly one argument (or one JSON value), after tokenising, so it can never be
re-parsed into extra flags. Without a board, operations still run and the variable commands say
plainly that none is bound.

The line language is exported for reuse and testing: `parseReplCommand`, `bindOperationLine`,
`referenceOf`, `followPath`, `tokenise`.

### HTTP

HTTP rendering lives in [`@devx-micro/cqrs-http-transport`](https://github.com/devx-micro/devx-micro/tree/main/libs/cqrs-http-transport), which keeps this
package free of `@nestjs/common`.

## Recording what was dispatched

Pass a `Recorder` from [`@devx-micro/observability-port`](https://github.com/devx-micro/devx-micro/tree/main/libs/observability-port) to observe every
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
