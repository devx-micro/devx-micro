# @devx-micro/app-cli

The command-line transport for a [`@devx-micro/app-runtime`](https://github.com/devx-micro/devx-micro/tree/main/libs/app-runtime) application: runs one operation from `argv`, prints its envelope as JSON and resolves to the exit code to use.

## Install

```bash
npm install @devx-micro/app-cli
```

It depends on [`@devx-micro/app-runtime`](https://github.com/devx-micro/devx-micro/tree/main/libs/app-runtime), which provides the `CqrsToolRuntime` it drives.

## Usage

```ts
import { runOneShot } from '@devx-micro/app-cli';

// node main.js --cli note.get --id 42
process.exitCode = await runOneShot(runtime, process.argv.slice(3));
```

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

`runOneShot(runtime, args, io?)` takes an optional `ToolIo` (`stdout` / `stderr` callbacks) so a
test can capture output instead of writing to the process.
