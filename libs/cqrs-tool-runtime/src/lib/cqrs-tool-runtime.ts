import type { SessionBoardPort } from './session-board';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  BoundedRecording,
  startTiming,
  wellFormed,
  type Clock,
  type ObservationInput,
  type Recorder,
} from '@devx-micro/observability-port';

import {
  TOOL_ENVELOPE_VERSION,
  TOOL_EXIT_CODES,
  ToolBus,
  ToolEnvelope,
  ToolOperationDescriptor,
  ToolRuntimeError,
  isIncompleteRun,
} from './contracts';
import {
  assertNoUnknownInput,
  describeValue,
  invalidInput,
  probeInput,
} from './input';

const isInputObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export interface CqrsToolRuntimeOptions {
  /**
   * The REPL's session variables. Optional: a runtime without it runs every operation,
   * and the REPL's variable commands say plainly that no session board is bound.
   */
  readonly sessionBoard?: SessionBoardPort;
  /** Executes the request of every `kind: 'command'` operation. */
  readonly commandBus: ToolBus;
  /** Executes the request of every `kind: 'query'` operation. */
  readonly queryBus: ToolBus;
  /** The operations this runtime serves. Names must be unique, or construction throws `DUPLICATE_OPERATION`. */
  readonly operations: readonly ToolOperationDescriptor[];
  /**
   * Where each dispatch is recorded. Optional and injected: this
   * library is shared and holds only the port, never the implementation, so an app that gives none
   * behaves exactly as before.
   */
  readonly recorder?: Recorder;
  /** Wall and monotonic clocks for the observation; the system clocks when absent. */
  readonly clock?: Clock;
  /** The `operator` recorded for every operation (the tool or app name). */
  readonly operator?: string;
  /**
   * How long a dispatch waits for the recorder before answering anyway (default 2000 ms). A recorder that never settles
   * (a wedged store) must not withhold the answer from the caller; a merely slow one is awaited.
   */
  readonly recordTimeoutMs?: number;
  /**
   * After a recording TIMES OUT the runtime stops asking the recorder for this long (default 30 000 ms), so a wedged
   * store costs the bound once and not on every call; a recorder that is merely slow never opens the breaker.
   */
  readonly recordCooldownMs?: number;
  /** Millisecond clock for the cooldown (`Date.now` when absent); injected for tests. */
  readonly now?: () => number;
}

/**
 * The plain-text operations listing `CqrsToolRuntime.help()` renders — pulled out as a standalone,
 * bus-free function so a caller that only ever needs `--help` output
 * can produce the EXACT same text without constructing a `CqrsToolRuntime` (which needs a
 * `commandBus`/`queryBus` — bus-shaped values a `--help` listing has no use for) at all. It was extracted for
 * a `--help` fast path that used to build a throwaway `CqrsToolRuntime` wired to a `ToolBus` that threw if ever called,
 * purely to reach this formatting. Sorts by name, mirroring `listOperations()`'s own sort, so a
 * caller passing an unsorted descriptor list still gets the same output `help()` would.
 */
export function formatOperationsHelp(
  operations: readonly Pick<
    ToolOperationDescriptor,
    'kind' | 'name' | 'summary'
  >[],
  executable = 'tool',
): string {
  const sorted = [...operations].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const empty = '';
  const lines = [
    empty,
    `Usage: ${executable} <operation> [--key value] [--json '{...}'] [--json-file <path>]`,
    empty,
    'Operations:',
    empty,
  ];
  const help = 'Help: ';
  const indent = ' '.padEnd(help.length);

  for (const operation of sorted) {
    lines.push(`Name: ${operation.name}`);
    lines.push(`Kind: ${operation.kind}`);

    const summary = operation.summary;
    if (summary.length <= 80 - indent.length) {
      lines.push(`${help}${summary}`);
    } else {
      let firstLine = true;
      let currentLine = empty;
      const words = summary.split(' ');
      for (const w of words) {
        const tentative = (currentLine ? currentLine + ' ' : empty) + w;
        if (tentative.trim().length >= 80 - indent.length) {
          if (firstLine) {
            lines.push(`${help}${currentLine.trim()}`);
            firstLine = false;
          } else {
            lines.push(`${indent}${currentLine.trim()}`);
          }
          currentLine = w;
        } else {
          currentLine = tentative;
        }
      }
      // Append any remaining text after the loop
      if (currentLine) {
        lines.push(`${indent}${currentLine.trim()}`);
      }
    }
    lines.push(empty);
  }
  lines.push(
    empty,
    'Common commands:',
    '  help [operation]       show command help',
    '  exit                   close the interactive REPL',
    '  quit                   close the interactive REPL',
    empty,
    'Modes:',
    '  --repl                 interactive command prompt',
    // 🔴 `--sidecar`, not `--driver`. Every app dispatches on `--sidecar`; nothing has ever read
    // `--driver`, and because an unrecognised flag falls through to the HTTP branch, following
    // this line started a **web server** instead of a JSON-lines driver. Found by typing what the
    // help said. The function is named `runJsonLinesDriver`, which is where the wrong word came from.
    '  --sidecar              newline-delimited JSON protocol',
    '  --cli                  one operation, then exit',
  );
  return lines.join('\n');
}

/**
 * Shared CQRS transport runtime: CLI, REPL, sidecar (JSON-lines), and HTTP's help route all
 * dispatch through this same class, wrapping a real `CommandBus`/`QueryBus` (or any `ToolBus`).
 */
export class CqrsToolRuntime {
  private readonly operations = new Map<string, ToolOperationDescriptor>();
  /** The recorder wait and breaker, shared with the dispatch seam (`observability-port`). */
  private readonly boundedRecording: BoundedRecording;

  /** The bound session board, if any. */
  public get sessionBoard(): SessionBoardPort | undefined {
    return this.options.sessionBoard;
  }

  public constructor(private readonly options: CqrsToolRuntimeOptions) {
    this.boundedRecording = new BoundedRecording({
      label: 'cqrs-tool-runtime',
      timeoutMs: options.recordTimeoutMs,
      cooldownMs: options.recordCooldownMs,
      now: options.now,
    });
    for (const operation of options.operations) {
      if (this.operations.has(operation.name)) {
        throw new ToolRuntimeError(
          'DUPLICATE_OPERATION',
          `Operation '${operation.name}' is registered more than once`,
          TOOL_EXIT_CODES.usage,
        );
      }
      this.operations.set(operation.name, operation);
    }
  }

  /** Every registered operation's `name`, `kind` and `summary`, sorted by name. */
  public listOperations(): readonly Pick<
    ToolOperationDescriptor,
    'kind' | 'name' | 'summary'
  >[] {
    return [...this.operations.values()]
      .map(({ kind, name, summary }) => ({ kind, name, summary }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  /** Structured help for transports that speak envelopes rather than formatted text. */
  public helpEnvelope(
    correlationId: string = randomUUID(),
    topic?: string,
  ): ToolEnvelope {
    if (topic) {
      const operation = this.listOperations().find(
        ({ name }) => name === topic,
      );
      if (!operation) {
        return this.errorEnvelope(
          'help',
          'system',
          correlationId,
          new ToolRuntimeError(
            'UNKNOWN_OPERATION',
            `Unknown help topic '${topic}'`,
            TOOL_EXIT_CODES.usage,
          ),
        );
      }
      return {
        schemaVersion: TOOL_ENVELOPE_VERSION,
        correlationId,
        operation: 'help',
        kind: 'system',
        status: 'success',
        exitCode: TOOL_EXIT_CODES.success,
        data: operation,
      };
    }
    return {
      schemaVersion: TOOL_ENVELOPE_VERSION,
      correlationId,
      operation: 'help',
      kind: 'system',
      status: 'success',
      exitCode: TOOL_EXIT_CODES.success,
      data: {
        operations: this.listOperations(),
        commonCommands: ['help', 'exit', 'quit'],
      },
    };
  }

  /**
   * Tab-completion candidates for a REPL line: operation names and common commands for the first
   * word, then option flags (`--json`, `--json-file`, …). Returned as a single group of candidates.
   */
  public completeReplLine(input: string): string[][] {
    const trimmed = input.trim();
    const options = ['--help', '--json', '--json-file', '--format'];
    const operationNames = this.listOperations().map(({ name }) => name);
    const commonCommands = ['help', 'exit', 'quit'];
    if (!trimmed) return [[...commonCommands, ...operationNames]];
    if (trimmed === 'help' || trimmed === '?')
      return [['help', '?', ...operationNames]];
    if (trimmed.startsWith('help ')) {
      const topic = trimmed.slice(5);
      return [operationNames.filter((name) => name.startsWith(topic))];
    }
    if (trimmed.startsWith('--')) {
      return [options.filter((option) => option.startsWith(trimmed))];
    }
    const parts = trimmed.split(/\s+/);
    const last = parts.at(-1) ?? '';
    if (last.startsWith('--')) {
      return [options.filter((option) => option.startsWith(last))];
    }
    if (parts.length > 1) return [[]];
    return [
      [...commonCommands, ...operationNames].filter((name) =>
        name.startsWith(trimmed),
      ),
    ];
  }

  /** The plain-text operations listing, with `executable` shown in the usage line. See {@link formatOperationsHelp}. */
  public help(executable = 'tool'): string {
    return formatOperationsHelp(this.listOperations(), executable);
  }

  /**
   * Runs one operation and answers with an envelope. **Never rejects**: an unknown operation, a
   * non-object input, a refused input, a handler failure and a stopped sequence are all reported in
   * the envelope's `status`, `exitCode` and `error`.
   *
   * @param operationName - The registered operation to run.
   * @param rawInput - The caller's input; must be a plain object.
   * @param correlationId - Echoed in the envelope; a random UUID when omitted.
   */
  public async dispatch(
    operationName: string,
    rawInput: Record<string, unknown> = {},
    correlationId: string = randomUUID(),
  ): Promise<ToolEnvelope> {
    const recorder = this.options.recorder;
    const operation = this.operations.get(operationName);
    // An unknown name is the caller's text, not a registered operation, so it is not recorded.
    if (!recorder || !operation || this.boundedRecording.isPaused())
      return this.run(operationName, rawInput, correlationId);
    // Snapshot the names before the handler runs: a handler that mutates its input must not change what the caller sent.
    let names: string[];
    try {
      names = isInputObject(rawInput) ? Object.keys(rawInput) : [];
    } catch {
      names = []; // an exotic input (a throwing proxy) must not change the result
    }

    let timing:
      | { finish(): ReturnType<ReturnType<typeof startTiming>['finish']> }
      | undefined;
    try {
      timing = startTiming(this.options.clock);
    } catch {
      timing = undefined;
    }
    const envelope = await this.run(operationName, rawInput, correlationId);
    await this.observe(
      recorder,
      operation,
      names,
      correlationId,
      envelope,
      timing,
    );
    return envelope;
  }

  /**
   * 🔴 **Recording never changes the result.** Anything the recorder, the clock or this mapping throws is
   * swallowed here; the recorder itself reports its own failures. The record is awaited, because a
   * one-shot CLI process exits when the envelope is written and an unawaited write would be lost.
   *
   * 🔴 **No argument value is recorded**: only the names of the keys that were given, and the
   * error *code* as failure evidence, never its message, which can echo caller text.
   */
  private async observe(
    recorder: Recorder,
    operation: ToolOperationDescriptor,
    names: string[],
    correlationId: string,
    envelope: ToolEnvelope,
    timing:
      | {
          finish(): {
            beforeTimestamp: string;
            afterTimestamp: string;
            durationMs?: number;
          };
        }
      | undefined,
  ): Promise<void> {
    try {
      // The handler already wrote the one completion; a second, generic one would be a double count.
      if (operation.recordsItself === true && envelope.status === 'success')
        return;
      const measured = timing?.finish();
      const observation: ObservationInput = {
        kind: operation.observationKind ?? 'operation',
        operator: this.options.operator ?? 'cqrs-tool-runtime',
        operation: operation.name,
        beforeTimestamp: measured?.beforeTimestamp ?? new Date().toISOString(),
        afterTimestamp: measured?.afterTimestamp ?? new Date().toISOString(),
        ...(measured?.durationMs !== undefined
          ? { durationMs: measured.durationMs }
          : {}),
        detail: (() => {
          // Bounded, because the names come from the caller: at most 32, each cut to 64 characters, with the true count.
          return {
            // The correlation id is caller text on HTTP, so it is made well-formed and bounded too (an oversized id would push the
            // whole detail, key names included, over the payload cap).
            correlationId: Array.from(wellFormed(correlationId))
              .slice(0, 128)
              .join(''),
            // Well-formed first (a name that arrives as a lone surrogate would make the record unhashable and silently
            // suppress the caller's own observation), then cut by code point so the cut cannot split a surrogate pair.
            inputKeys: names
              .slice(0, 32)
              .map((name) =>
                Array.from(wellFormed(name)).slice(0, 64).join(''),
              ),
            inputKeyCount: names.length,
          };
        })(),
        result:
          envelope.status === 'success'
            ? { outcome: 'success', evidence: [] }
            : envelope.status === 'incomplete'
              ? { outcome: 'blocked', evidence: ['incomplete-run'] }
              : {
                  outcome: 'failure',
                  evidence: [
                    wellFormed(envelope.error?.code ?? 'HANDLER_FAILURE'),
                  ],
                },
      };
      await this.boundedRecording.run(() => recorder.record(observation));
    } catch {
      // A recording failure must not change the observed unit's result.
    }
  }

  private async run(
    operationName: string,
    rawInput: Record<string, unknown>,
    correlationId: string,
  ): Promise<ToolEnvelope> {
    const operation = this.operations.get(operationName);
    if (!operation) {
      return this.errorEnvelope(
        operationName,
        'system',
        correlationId,
        new ToolRuntimeError(
          'UNKNOWN_OPERATION',
          `Unknown operation '${operationName}'`,
          TOOL_EXIT_CODES.usage,
        ),
      );
    }

    try {
      // 🔴 The input's SHAPE is refused here, by name, before any hook runs. The type is erased at
      // every transport boundary — an HTTP body, a sidecar line — and a string, number or null
      // used to reach `probeInput`'s Proxy, whose TypeError the catch below flattened to
      // HANDLER_FAILURE at exit 1: a caller's error reported as a server's
      // An array is a legal Proxy
      // target and would otherwise be validated as an object with no keys.
      if (!isInputObject(rawInput)) {
        throw invalidInput(
          `${operation.name} needs its input to be an object; received ${describeValue(rawInput)}.`,
        );
      }
      // 🔴 `validate` is handed a **probe**, not the raw input, so the runtime learns which keys
      // the hook actually looked at — the only honest definition of what this operation accepts.
      //
      // The refusal comes *after* `validate` returns: a missing required argument is the better
      // message when both are true, and a hook that threw never reaches here. Operations with no
      // `validate` keep pass-through semantics, because there is nothing to learn from.
      let input: unknown;
      if (operation.validate) {
        const probe = probeInput(rawInput);
        input = operation.validate(probe.input);
        assertNoUnknownInput(operation.name, rawInput, probe);
      } else {
        input = rawInput;
      }

      const request = operation.createRequest(input as Record<string, unknown>);
      const bus =
        operation.kind === 'command'
          ? this.options.commandBus
          : this.options.queryBus;
      const data = await bus.execute(request);
      // 🔴 **Read the result, not the control flow.** A resumable sequence that refuses a step
      // returns normally, so "did not throw" was never the same question as "finished". The payload
      // is kept either way — it names the step that stopped and everything that ran before it,
      // which is what a caller needs in order to resume rather than to start again.
      const stopped = isIncompleteRun(data);
      return {
        schemaVersion: TOOL_ENVELOPE_VERSION,
        correlationId,
        operation: operation.name,
        kind: operation.kind,
        status: stopped ? 'incomplete' : 'success',
        exitCode: stopped ? TOOL_EXIT_CODES.blocked : TOOL_EXIT_CODES.success,
        data,
      };
    } catch (error) {
      return this.errorEnvelope(
        operation.name,
        operation.kind,
        correlationId,
        error,
      );
    }
  }

  private errorEnvelope(
    operation: string,
    kind: ToolEnvelope['kind'],
    correlationId: string,
    error: unknown,
  ): ToolEnvelope {
    const runtimeError =
      error instanceof ToolRuntimeError ? error : fromDomainError(error);
    return {
      schemaVersion: TOOL_ENVELOPE_VERSION,
      correlationId,
      operation,
      kind,
      status: 'error',
      exitCode: runtimeError.exitCode,
      error: {
        code: runtimeError.code,
        message: runtimeError.message,
        ...(runtimeError.details === undefined
          ? {}
          : { details: runtimeError.details }),
      },
    };
  }
}

/**
 * 🔴 **A domain error's own `code` survives into the envelope.**
 *
 * Everything that was not a `ToolRuntimeError` used to become `HANDLER_FAILURE`, which broke the
 * contract the shared documentation states in bold: *"Branch on `error.code`, never on the message
 * text."* A caller could not tell "this directory is not a project" from "the store is broken" from
 * "that id already exists" — all three arrived as one code with the message as their only
 * distinguishing feature, which is exactly what callers are told not to read.
 *
 * The errors that carry a code already existed — domain errors such as a not-found error or a
 * persistence adapter's `store-locked` already carried their own codes. This stops flattening them.
 *
 * `exitCode` is honoured the same way, so a domain that knows an operation was **refused** rather
 * than **broken** can say so; anything that does not know keeps the old `1`.
 */
function fromDomainError(error: unknown): ToolRuntimeError {
  const carried = error as { code?: unknown; exitCode?: unknown } | null;
  const code =
    typeof carried?.code === 'string' && carried.code.trim()
      ? carried.code
      : 'HANDLER_FAILURE';
  const exitCode =
    typeof carried?.exitCode === 'number' && Number.isInteger(carried.exitCode)
      ? carried.exitCode
      : TOOL_EXIT_CODES.failure;
  return new ToolRuntimeError(
    code,
    error instanceof Error ? error.message : 'Unknown handler failure',
    exitCode,
  );
}

export function parseToolArguments(arguments_: readonly string[]): {
  readonly operation: string;
  readonly input: Record<string, unknown>;
} {
  const [operation, ...rest] = arguments_;
  if (!operation || operation.startsWith('-')) {
    throw new ToolRuntimeError(
      'MISSING_OPERATION',
      'An operation is required',
      TOOL_EXIT_CODES.usage,
    );
  }

  const input: Record<string, unknown> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    // 🔴 **`--json-file`, alongside `--json`, not instead of it.** A `--json` payload is a single
    // shell-quoted argument, and any backtick or apostrophe inside it (common in commit messages,
    // prose, or code identifiers quoted in a review artifact) closes the caller's own shell quote
    // early — a shell syntax error, not a JSON parse error, easy to misdiagnose as malformed JSON
    // when the JSON itself is fine. `--json-file <path>` reads the payload from disk instead: a
    // file written by any tool (no shell involved at all) has no quoting question to get wrong.
    // Both flags feed the identical parse-and-merge path below, so neither gets its own
    // error-shape or accumulate behaviour to drift from the other's.
    //
    // 🔴 **`readFileSync`, deliberately, not the async `fs/promises` read** — code review
    // (efficiency angle) correctly notes this blocks the event loop for the read's duration, which
    // matters for `runInteractiveRepl`'s long-lived loop and not for `runOneShot`'s one-shot
    // process. Accepted rather than fixed: this flag's payload is a small JSON *object* (the same
    // size class `--json`'s own inline argument already assumes), not a bulk-data path, and
    // `parseToolArguments`'s synchronous signature is depended on by both transports today — making
    // this one read async would mean making the whole function async for a payload class this tool
    // was never meant to carry large files through.
    //
    // 🔴 **Relative paths resolve against the process's own `cwd`, not a shell the operator may
    // have `cd`'d in meanwhile** — code review (cross-file angle) flagged this for
    // `runInteractiveRepl`'s long-lived loop specifically. This is standard, expected Node
    // behaviour for any long-running process taking path arguments, not something `--json-file`
    // introduces; an absolute path sidesteps the question entirely, which is what this file's own
    // tests use throughout.
    //
    // 🔴 **A new flag name is a new token an unquoted REPL line could accidentally collide
    // with — inherent to any `--flag`-recognising parser, not unique to this one** —
    // code review (cross-file angle) traced the escalation precisely: an unquoted business
    // value that happened to contain the literal token `--json` already risked the same class of
    // accidental merge (of data the caller already typed); `--json-file` escalates the *outcome*
    // of that same pre-existing collision from re-injecting visible caller data to a same-machine
    // file read. Accepted rather than redesigned: the REPL's own trust boundary is already
    // same-process/same-user (whoever drives it can already run arbitrary commands as that user),
    // and no flag-parsing scheme built on positional token matching can close this without
    // requiring every caller to quote data that merely resembles a flag — which every other flag
    // here already asks of its own callers.
    if (argument === '--json' || argument === '--json-file') {
      const isFile = argument === '--json-file';
      const raw = rest[index + 1];
      if (!raw) {
        throw new ToolRuntimeError(
          'MISSING_JSON',
          `${argument} requires ${isFile ? 'a file path' : 'an object'}`,
          TOOL_EXIT_CODES.usage,
        );
      }
      let json: string;
      if (isFile) {
        try {
          // 🔴 **BOM stripped, deliberately — code review finding.** A `--json` payload arrives
          // as a shell argument, which can never carry a byte-order-mark; a JSON *file* saved by a
          // common Windows/PowerShell/Excel export often does (`Set-Content` without
          // `-Encoding utf8NoBOM`, U+FEFF at byte 0), and `JSON.parse` refuses it at position 0.
          // Without this, `--json-file` would be silently stricter than the `--json` payload it
          // exists to replace, for well-formed JSON that merely arrived with a BOM.
          json = readFileSync(raw, 'utf8');
          if (json.charCodeAt(0) === 0xfeff) json = json.slice(1);
        } catch (error) {
          // 🔴 **`JSON_FILE_UNREADABLE`, not `MISSING_JSON` — code review finding.** `MISSING_JSON`
          // above means "no path was given at all"; ENOENT/EACCES/EISDIR mean a path *was* given and
          // reading it failed for a real, distinct reason. This file's own contract elsewhere is
          // "branch on `error.code`, never on the message text" — conflating the two would leave a
          // caller unable to tell "you forgot the flag" from "the file exists but you can't read it
          // (wrong permissions, a directory, a typo one level too deep)".
          throw new ToolRuntimeError(
            'JSON_FILE_UNREADABLE',
            `${argument} could not read '${raw}': ${
              error instanceof Error ? error.message : String(error)
            }`,
            TOOL_EXIT_CODES.usage,
          );
        }
      } else {
        json = raw;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch {
        throw new ToolRuntimeError(
          'INVALID_JSON',
          `${argument} must contain valid JSON`,
          TOOL_EXIT_CODES.usage,
        );
      }
      if (!isInputObject(parsed)) {
        throw new ToolRuntimeError(
          'INVALID_JSON',
          `${argument} must contain a JSON object`,
          TOOL_EXIT_CODES.usage,
        );
      }
      // 🔴 Through the same accumulate rule as a flag: a key given by `--json`/`--json-file` AND by
      // a flag, in either order, or by two of them, is one key given twice — accumulated, never the
      // later silently winning.
      for (const [key, value] of Object.entries(parsed)) {
        accumulate(input, key, value, `${argument}'s '${key}'`);
      }
      index += 1;
      continue;
    }
    if (!argument.startsWith('--')) {
      throw new ToolRuntimeError(
        'UNEXPECTED_ARGUMENT',
        `Unexpected argument '${argument}'`,
        TOOL_EXIT_CODES.usage,
      );
    }
    const key = argument.slice(2);
    const value = rest[index + 1];
    const bare = !value || value.startsWith('--');
    accumulate(input, key, bare ? true : value, `'--${key}'`);
    if (!bare) index += 1;
  }
  return { operation, input };
}

/**
 * 🔴 A repeated key ACCUMULATES: `--scope a.ts --scope b.ts` is `['a.ts', 'b.ts']`, in order, and
 * so is a key given by `--json` and by a flag. It used to be `input[key] = value` unconditionally,
 * so the second overwrote the first and a command recorded one scope while reporting success.
 * A single-valued argument given twice now reaches
 * its validator as an array — and every validator must REFUSE that by name rather than map a
 * non-string to "absent" (an `optional()` helper that did so once ingested a default root). Visible, not last-wins and not silently-absent. A bare flag (`--x`
 * with no value) has no value to put in a list: given twice, or beside a valued one, it is refused
 * here. `hasOwnProperty`, not `in`: `--constructor` is not "already present" on a fresh object.
 */
function accumulate(
  input: Record<string, unknown>,
  key: string,
  value: unknown,
  source: string,
): void {
  if (!Object.prototype.hasOwnProperty.call(input, key)) {
    input[key] = value;
    return;
  }
  const existing = input[key];
  if (value === true || existing === true) {
    throw new ToolRuntimeError(
      'INVALID_INPUT',
      `${source} is given more than once, and one of them is a bare flag with no value to repeat`,
      TOOL_EXIT_CODES.usage,
    );
  }
  const values = (v: unknown): unknown[] => (Array.isArray(v) ? v : [v]);
  input[key] = [...values(existing), ...values(value)];
}
