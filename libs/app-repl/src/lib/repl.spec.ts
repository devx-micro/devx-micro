import { Readable, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import {
  CqrsToolRuntime,
  type ToolBus,
  type ToolOperationDescriptor,
} from '@devx-micro/app-runtime';

import { formatReplHelp, runInteractiveRepl } from './repl';

class RecordingBus implements ToolBus {
  public readonly received: unknown[] = [];
  constructor(private readonly handler: (request: unknown) => unknown) {}
  async execute(request: unknown): Promise<unknown> {
    this.received.push(request);
    return this.handler(request);
  }
}

function createCapturingWritable(): { output: Writable; text: () => string } {
  const chunks: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return { output, text: () => chunks.join('') };
}

function createRuntime(store = { value: undefined as unknown }) {
  const rememberOperation: ToolOperationDescriptor = {
    name: 'remember',
    summary: 'Remember a value',
    kind: 'command',
    createRequest: (input) => ({ type: 'remember', value: input['value'] }),
  };
  const recallOperation: ToolOperationDescriptor = {
    name: 'recall',
    summary: 'Recall the remembered value',
    kind: 'query',
    createRequest: () => ({ type: 'recall' }),
  };
  const commandBus = new RecordingBus((request) => {
    const command = request as { type: string; value: unknown };
    store.value = command.value;
    return { stored: true };
  });
  const queryBus = new RecordingBus(() => store.value ?? null);
  return {
    runtime: new CqrsToolRuntime({
      commandBus,
      queryBus,
      operations: [rememberOperation, recallOperation],
    }),
    commandBus,
    queryBus,
    store,
  };
}

describe('runInteractiveRepl', () => {
  it('runs a stateful interactive REPL session and honors exit', async () => {
    const { runtime } = createRuntime();
    const input = Readable.from([
      'remember --value repl\n',
      'recall\n',
      'exit\n',
    ]);
    const { output, text } = createCapturingWritable();
    await runInteractiveRepl(runtime, input, output);
    expect(text()).toContain('DATA');
    expect(text()).toContain('repl');
  });
});

/**
 * The REPL's own help, which is man-page shaped rather than the CLI's usage text.
 *
 * 🔴 An unknown topic must come back as a **structured error envelope**, not as an empty page. A
 * REPL that prints a blank help section for a typo reads as "this operation exists and is
 * undocumented", which sends the reader looking for the wrong thing.
 */
describe('formatReplHelp', () => {
  it('lists the operations when no topic is given', () => {
    const { runtime } = createRuntime();

    const help = formatReplHelp(runtime);

    expect(help).toContain('CQRS-TOOL(1)');
    expect(help).toContain('remember');
    expect(help).toContain('recall');
  });

  it('renders one operation as its own page, with its kind', () => {
    const { runtime } = createRuntime();

    const help = formatReplHelp(runtime, 'recall');

    expect(help).toContain('CQRS-TOOL-RECALL(1)');
    expect(help).toContain('QUERY');
    expect(help).toContain('Recall the remembered value');
  });

  it('reports an unknown topic as an error envelope rather than an empty page', () => {
    const { runtime } = createRuntime();

    const help = formatReplHelp(runtime, 'nonexistent');

    expect(help).toContain('UNKNOWN_OPERATION');
    expect(help).toContain('nonexistent');
  });
});

describe('the REPL loop', () => {
  it('answers `help` and `help <operation>` without dispatching anything', async () => {
    const { runtime, commandBus, queryBus } = createRuntime();
    const input = Readable.from(['help\n', 'help remember\n', 'quit\n']);
    const { output, text } = createCapturingWritable();

    await runInteractiveRepl(runtime, input, output);

    expect(text()).toContain('CQRS-TOOL(1)');
    expect(text()).toContain('CQRS-TOOL-REMEMBER(1)');
    expect(commandBus.received).toHaveLength(0);
    expect(queryBus.received).toHaveLength(0);
  });

  it('closes on `quit` as well as `exit`', async () => {
    const { runtime } = createRuntime();
    const input = Readable.from(['quit\n', 'recall\n']);
    const { output, text } = createCapturingWritable();

    await runInteractiveRepl(runtime, input, output);

    // The line after `quit` must not be executed — a REPL that keeps reading after being told to
    // close will run whatever was already typed ahead of it.
    expect(text()).not.toContain('DATA');
  });

  it('ignores a blank line instead of dispatching an empty operation', async () => {
    const { runtime, commandBus } = createRuntime();
    const input = Readable.from(['\n', '   \n', 'exit\n']);
    const { output } = createCapturingWritable();

    await runInteractiveRepl(runtime, input, output);

    expect(commandBus.received).toHaveLength(0);
  });

  it('reports an unknown operation and keeps the session open', async () => {
    const { runtime } = createRuntime();
    const input = Readable.from(['nope\n', 'recall\n', 'exit\n']);
    const { output, text } = createCapturingWritable();

    await runInteractiveRepl(runtime, input, output);

    expect(text()).toContain('UNKNOWN_OPERATION');
    // Still answering afterwards: a REPL that dies on a typo is worse than one that says no.
    expect(text()).toContain('DATA');
  });
});
