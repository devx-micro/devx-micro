# @devx-micro/app-repl

The interactive transport for a [`@devx-micro/app-runtime`](https://github.com/devx-micro/devx-micro/tree/main/libs/app-runtime) application: a prompt with tab completion, `help [operation]`, and optional session variables.

## Install

```bash
npm install @devx-micro/app-repl
```

It depends on [`@devx-micro/app-runtime`](https://github.com/devx-micro/devx-micro/tree/main/libs/app-runtime), which provides the `CqrsToolRuntime` it drives.

## Usage

```ts
import { runInteractiveRepl } from '@devx-micro/app-repl';

// node main.js --repl
await runInteractiveRepl(runtime); // or (runtime, input, output) to drive it from streams
```

An interactive prompt with tab completion, `help [operation]`, and `exit` / `quit`. Each line may be
flags (`note.get --id 42`) or a JSON request. Every line is dispatched with the correlation id
`<sessionId>.<n>`, so one sitting can be grouped.

If you bind a `SessionBoardPort` (see the runtime's `sessionBoard` option), the REPL also supports
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
`referenceOf`, `followPath`, `tokenise`. `formatReplResponse`, `formatReplHelp` and
`completeReplWithVariables` are exported too.
