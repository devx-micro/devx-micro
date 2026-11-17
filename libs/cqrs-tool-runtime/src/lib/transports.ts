import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import {
  TOOL_ENVELOPE_VERSION,
  TOOL_EXIT_CODES,
  ToolEnvelope,
  ToolIo,
  ToolRuntimeError,
} from './contracts';
import { CqrsToolRuntime, parseToolArguments } from './cqrs-tool-runtime';
import { bindOperationLine, describeVariable, parseReplCommand, type VariableLookup } from './repl-language';

const defaultIo: ToolIo = {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
};

export function formatReplResponse(response: unknown): string {
  const envelope =
    response && typeof response === 'object'
      ? (response as Record<string, unknown>)
      : {};
  const lines = [
    'CQRS-TOOL(1)',
    '',
    'NAME',
    '    CQRS command and query runtime',
    '',
    'STATUS',
  ];
  lines.push(`    ${String(envelope['status'] ?? 'unknown').toUpperCase()}`);
  if (typeof envelope['operation'] === 'string')
    lines.push('', 'OPERATION', `    ${envelope['operation']}`);
  if (typeof envelope['correlationId'] === 'string')
    lines.push('', 'CORRELATION', `    ${envelope['correlationId']}`);
  if (envelope['error'] && typeof envelope['error'] === 'object') {
    const error = envelope['error'] as Record<string, unknown>;
    lines.push(
      '',
      'ERROR',
      `    ${String(error['code'] ?? 'unknown')}: ${String(error['message'] ?? 'Unknown error')}`,
    );
  }
  if ('data' in envelope) {
    lines.push('', 'DATA');
    const data =
      JSON.stringify(envelope['data'], null, 2) ?? String(envelope['data']);
    lines.push(...data.split('\n').map((line) => `    ${line}`));
  }
  return `${lines.join('\n')}\n`;
}

export function formatReplHelp(
  runtime: CqrsToolRuntime,
  topic?: string,
): string {
  const title = topic ? `CQRS-TOOL-${topic.toUpperCase()}(1)` : 'CQRS-TOOL(1)';
  const lines = [
    title,
    '',
    'NAME',
    `    ${topic ?? 'tool'} - ${topic ? 'command reference' : 'CQRS command and query runtime'}`,
  ];
  if (topic) {
    const operation = runtime
      .listOperations()
      .find(({ name }) => name === topic);
    if (!operation)
      return formatReplResponse({
        status: 'error',
        operation: 'help',
        error: {
          code: 'UNKNOWN_OPERATION',
          message: `Unknown help topic '${topic}'`,
        },
      });
    lines.push(
      '',
      'SYNOPSIS',
      `    ${topic} [--key value] [--json '{...}'] [--json-file <path>]`,
      '',
      'TYPE',
      `    ${operation.kind.toUpperCase()}`,
      '',
      'DESCRIPTION',
      `    ${operation.summary}`,
    );
  } else {
    lines.push(
      '',
      'SYNOPSIS',
      '    help [operation]',
      '',
      'DESCRIPTION',
      '    Show available commands or detailed help for one command.',
      '',
      'COMMANDS',
      ...runtime
        .listOperations()
        .map(
          ({ name, kind, summary }) =>
            `    ${name.padEnd(20)} ${kind.padEnd(7)} ${summary}`,
        ),
    );
    if (runtime.sessionBoard) {
      lines.push(
        '',
        'VARIABLES',
        '    set $name = <operation line>   run it and keep its result',
        '    $name.field[0]                 use a kept value as ONE argument (write $$ for a literal $)',
        '    vars                           list the variables',
        '    unset $name                    remove one',
        '    board save <name>              save the variables as the named board board:<name>',
        '    board attach <name>            copy the entries of board:<name> in as variables',
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

export function completeReplLine(
  runtime: CqrsToolRuntime,
  line: string,
): string[][] {
  return runtime.completeReplLine(line);
}

export async function runOneShot(
  runtime: CqrsToolRuntime,
  arguments_: readonly string[],
  io: ToolIo = defaultIo,
): Promise<number> {
  if (arguments_.includes('--help') || arguments_.includes('-h')) {
    io.stdout(runtime.help());
    return TOOL_EXIT_CODES.success;
  }
  if (arguments_[0] === 'help') {
    const envelope = runtime.helpEnvelope(undefined, arguments_[1]);
    io.stdout(JSON.stringify(envelope));
    return envelope.exitCode;
  }
  try {
    const { operation, input } = parseToolArguments(arguments_);
    const envelope = await runtime.dispatch(operation, input);
    io.stdout(JSON.stringify(envelope));
    return envelope.exitCode;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Invalid arguments';
    const envelope: ToolEnvelope = {
      schemaVersion: TOOL_ENVELOPE_VERSION,
      correlationId: 'argument-parsing',
      operation: 'parse',
      kind: 'system',
      status: 'error',
      exitCode: TOOL_EXIT_CODES.usage,
      error: { code: 'INVALID_ARGUMENTS', message },
    };
    io.stdout(JSON.stringify(envelope));
    return envelope.exitCode;
  }
}

export interface DriverRequest {
  readonly operation: string;
  readonly input?: Record<string, unknown>;
  readonly correlationId?: string;
}

/** Newline-delimited JSON transport — used by the sidecar/VS Codium Extension integration. */
export async function runJsonLinesDriver(
  runtime: CqrsToolRuntime,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      const request = JSON.parse(line) as DriverRequest;
      if (request.operation === 'help') {
        const topic = request.input?.['topic'];
        output.write(
          `${JSON.stringify(
            runtime.helpEnvelope(
              request.correlationId,
              typeof topic === 'string' ? topic : undefined,
            ),
          )}\n`,
        );
        continue;
      }
      const envelope = await runtime.dispatch(
        request.operation,
        request.input ?? {},
        request.correlationId,
      );
      output.write(`${JSON.stringify(envelope)}\n`);
    } catch {
      const envelope: ToolEnvelope = {
        schemaVersion: TOOL_ENVELOPE_VERSION,
        correlationId: 'invalid-json-line',
        operation: 'driver',
        kind: 'system',
        status: 'error',
        exitCode: TOOL_EXIT_CODES.usage,
        error: {
          code: 'INVALID_JSON_LINE',
          message: 'Each input line must be valid JSON',
        },
      };
      output.write(`${JSON.stringify(envelope)}\n`);
    }
  }
}

/** What the REPL's completer knows about the session's variables: each name and its top-level fields. */
type VariableIndex = ReadonlyMap<string, readonly string[]>;

/** Completes `$name` and `$name.field` against what the session holds; otherwise as the runtime does. */
export function completeReplWithVariables(
  runtime: CqrsToolRuntime,
  line: string,
  variables: VariableIndex | undefined,
): string[] {
  // No session board: no variables, and no variable commands to offer.
  if (variables === undefined || !runtime.sessionBoard) return runtime.completeReplLine(line).flat();
  const last = line.split(/\s+/).at(-1) ?? '';
  if (last.startsWith('$') && !last.startsWith('$$')) {
    const dot = last.indexOf('.');
    if (dot === -1) {
      return [...variables.keys()].map((name) => `$${name}`).filter((candidate) => candidate.startsWith(last));
    }
    const name = last.slice(1, dot);
    return (variables.get(name) ?? []).filter((field) => /^[A-Za-z0-9_-]+$/.test(field)).map((field) => `$${name}.${field}`).filter((candidate) => candidate.startsWith(last));
  }
  const base = runtime.completeReplLine(line).flat();
  if (line.trim() === '' || !line.includes(' ')) {
    return [...base, ...['vars', 'set', 'unset', 'board'].filter((c) => c.startsWith(line.trim()) && !base.includes(c))];
  }
  return base;
}

const NO_SESSION_BOARD =
  'This REPL has no session board bound, so variables are unavailable here (an app binds one with SessionBoardPort).';

/**
 * Stateful interactive REPL — the transport Domain Assembly Cucumber/Screenplay tests drive.
 *
 * A session has an id, and every line is dispatched with a correlation id built from it
 * (`<sessionId>.<line>`), so the lines of one sitting can be grouped (ADR-066 D7). That holds in
 * every app. Variables (`set $x = …`, `$x.path`, `vars`, `unset`, `board attach|save`) additionally
 * need a `SessionBoardPort` on the runtime.
 */
export async function runInteractiveRepl(
  runtime: CqrsToolRuntime,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<void> {
  const sessionId = `s-${randomBytes(6).toString('hex')}`;
  const board = runtime.sessionBoard;
  const variables = new Map<string, readonly string[]>();

  // Completion's index is best-effort: a store that fails here must not hide that the command itself worked,
  // and a partial read must not leave the old index half-cleared.
  const refresh = async (): Promise<void> => {
    if (!board) return;
    try {
      const next = new Map<string, readonly string[]>();
      for (const name of await board.names(sessionId)) {
        const { value } = await board.get(sessionId, name);
        next.set(name, typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.keys(value) : []);
      }
      variables.clear();
      for (const [name, fields] of next) variables.set(name, fields);
    } catch {
      // keep the previous index
    }
  };
  const lookup: VariableLookup | undefined = board ? (name) => board.get(sessionId, name) : undefined;

  output.write(
    `${runtime.help()}\n\nEnter commands with flags or JSON requests; type 'exit' or 'quit' to quit.\n` +
      `Session ${sessionId}${board ? ' — variables: set $x = <operation>, $x.path, vars, unset $x, board attach|save <name>' : ''}\n`,
  );
  const lines = createInterface({
    input,
    output,
    prompt: 'tool> ',
    completer: (line: string) => {
      // readline replaces the text it is handed back as the second element, so that must be the word being
      // completed, not the whole line, or a completion after the first word inserts nothing.
      const word = line.split(/\s+/).at(-1) ?? '';
      const candidates = completeReplWithVariables(runtime, line, board ? variables : undefined);
      return [candidates.filter((candidate) => candidate.startsWith(word)), word];
    },
  });
  let active = true;
  const prompt = () => {
    try {
      lines.prompt();
    } catch {
      active = false;
    }
  };
  const failure = (error: unknown) => {
    // A malformed line is the person's (INVALID_INPUT, at `parse`); anything else is a fault in what the line reached.
    const carried = (error as { code?: unknown } | null)?.code;
    const mine = error instanceof ToolRuntimeError || !(error instanceof Error);
    return formatReplResponse({
      status: 'error',
      operation: mine ? 'parse' : 'repl',
      error: {
        // Exactly as before this phase, a malformed line is INVALID_INPUT; the one new code is the one that says why variables are unavailable.
        code: error instanceof ToolRuntimeError && error.code === 'NO_SESSION_BOARD' ? error.code : mine ? 'INVALID_INPUT' : typeof carried === 'string' ? carried : 'HANDLER_FAILURE',
        message: error instanceof Error ? error.message : 'Invalid input',
      },
    });
  };
  let lineNumber = 0;
  const dispatch = async (text: string) => {
    const request = await bindOperationLine(text, lookup);
    lineNumber += 1;
    return runtime.dispatch(request.operation, request.input, `${sessionId}.${lineNumber}`);
  };

  prompt();
  try {
    for await (const line of lines) {
      if (['exit', 'quit', '.exit', '.quit'].includes(line.trim())) {
        active = false;
        break;
      }
      if (line.trim()) {
        try {
          const trimmed = line.trim();
          if (trimmed === 'help' || trimmed === '?') {
            output.write(formatReplHelp(runtime));
            if (active) prompt();
            continue;
          }
          if (trimmed.startsWith('help ')) {
            output.write(formatReplHelp(runtime, trimmed.slice(5).trim()));
            if (active) prompt();
            continue;
          }
          const operationNames = new Set(runtime.listOperations().map((o) => o.name));
          const command = parseReplCommand(trimmed, (name) => operationNames.has(name));
          if (command.kind === 'operation') {
            output.write(formatReplResponse(await dispatch(command.line)));
          } else if (!board) {
            output.write(failure(new ToolRuntimeError('NO_SESSION_BOARD', NO_SESSION_BOARD, TOOL_EXIT_CODES.usage)));
          } else if (command.kind === 'set') {
            const envelope = await dispatch(command.line);
            output.write(formatReplResponse(envelope));
            if (envelope.status === 'success') {
              try {
                await board.set(sessionId, command.name, envelope.data === undefined ? null : envelope.data);
              } catch (error) {
                // The operation has already run, and running it again would repeat its effect: say so.
                output.write(`$${command.name} not set: ${error instanceof Error ? error.message : 'the store refused it'} (the operation itself ran, so do not repeat it).\n`);
                if (active) prompt();
                continue;
              }
              output.write(`$${command.name} set.\n`);
              await refresh();
            } else {
              output.write(`$${command.name} not set: the operation did not succeed.\n`);
            }
          } else if (command.kind === 'vars') {
            const names = await board.names(sessionId);
            if (names.length === 0) output.write('No variables set.\n');
            for (const name of names) {
              output.write(`$${name}  ${describeVariable((await board.get(sessionId, name)).value)}\n`);
            }
          } else if (command.kind === 'unset') {
            output.write((await board.unset(sessionId, command.name)) ? `$${command.name} unset.\n` : `$${command.name} was not set.\n`);
            await refresh();
          } else if (command.kind === 'attach') {
            const result = await board.attach(sessionId, command.board);
            output.write(`Attached board:${command.board}: ${result.attached} variable(s)${result.skipped ? `, ${result.skipped} skipped (key is not a variable name)` : ''}.\n`);
            await refresh();
          } else if (command.kind === 'save') {
            await board.save(sessionId, command.name);
            output.write(`Saved the session's variables as board:${command.name}.\n`);
          }
        } catch (error) {
          output.write(failure(error));
        }
      }
      if (active) prompt();
    }
  } finally {
    // Ending a session discards its board; a saved copy is unaffected. A killed session never gets
    // here, so its board lapses by TTL instead (ADR-066 D2).
    if (board) await board.end(sessionId).catch(() => undefined);
  }
}
