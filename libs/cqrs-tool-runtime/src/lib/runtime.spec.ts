import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { CqrsToolRuntime, parseToolArguments } from './cqrs-tool-runtime';
import {
  formatReplHelp,
  runInteractiveRepl,
  runJsonLinesDriver,
  runOneShot,
} from './transports';
import type { ToolBus, ToolOperationDescriptor } from './contracts';
import { TOOL_EXIT_CODES, ToolRuntimeError } from './contracts';

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

/**
 * An operation that declares what it accepts, so the runtime can tell an unknown key from a
 * known one. `nested` is optional — the case that used to fail silently, because a typo of an
 * optional argument leaves every required one satisfied.
 */
const strictOperation: ToolOperationDescriptor = {
  name: 'strict',
  summary: 'An operation with one required and one optional argument',
  kind: 'command',
  validate: (input) => {
    const value = input['value'];
    if (typeof value !== 'string') {
      throw new ToolRuntimeError(
        'INVALID_INPUT',
        "strict needs a string 'value'",
        TOOL_EXIT_CODES.usage,
      );
    }
    return { value, nested: input['nested'] };
  },
  createRequest: (input) => ({ type: 'strict', ...input }),
};

const strictRuntime = () =>
  new CqrsToolRuntime({
    commandBus: new RecordingBus(() => ({ ok: true })),
    queryBus: new RecordingBus(() => null),
    operations: [strictOperation],
  });

describe('parseToolArguments', () => {
  it('a repeated flag records every value, in order — not the last alone', () => {
    // `defect.open --scope a.ts --scope b.ts` recorded one scope and reported success
    // (d-20260910-a-repeated-cli-flag-silently-keeps): the second assignment overwrote the first.
    const { input } = parseToolArguments([
      'defect.open',
      '--scope',
      'a.ts',
      '--scope',
      'b.ts',
      '--title',
      't',
    ]);
    expect(input['scope']).toEqual(['a.ts', 'b.ts']);
    expect(input['title']).toBe('t');
  });

  it('a flag repeated three times is three values; a bare repeated flag is refused, not folded into the list', () => {
    const { input } = parseToolArguments([
      'op',
      '--x',
      '1',
      '--x',
      '2',
      '--x',
      '3',
    ]);
    expect(input['x']).toEqual(['1', '2', '3']);
    expect(() => parseToolArguments(['op', '--x', '1', '--x'])).toThrow(
      /'--x' is given more than once/,
    );
  });

  it('a key given by --json and by a flag accumulates in either order; two --json objects too (QA)', () => {
    expect(
      parseToolArguments(['op', '--scope', 'a', '--json', '{"scope":"b"}'])
        .input['scope'],
    ).toEqual(['a', 'b']);
    expect(
      parseToolArguments(['op', '--json', '{"scope":["a"]}', '--scope', 'b'])
        .input['scope'],
    ).toEqual(['a', 'b']);
    expect(
      parseToolArguments(['op', '--json', '{"a":1}', '--json', '{"a":2}'])
        .input['a'],
    ).toEqual([1, 2]);
    expect(() =>
      parseToolArguments(['op', '--json', '{"dry":true}', '--dry', 'x']),
    ).toThrow(/given more than once/);
  });

  it('a key that is also an Object.prototype name is not "already present" on a fresh input (QA)', () => {
    expect(
      parseToolArguments(['op', '--constructor', 'a']).input['constructor'],
    ).toBe('a');
    expect(
      parseToolArguments(['op', '--toString', 'a', '--toString', 'b']).input[
        'toString'
      ],
    ).toEqual(['a', 'b']);
  });

  describe('--json-file', () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'cqrs-json-file-'));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('reads a JSON object from disk, same as --json but with no shell-quoting question', () => {
      // The exact case --json cannot survive: a backtick and an apostrophe in the same payload.
      const path = join(dir, 'payload.json');
      writeFileSync(
        path,
        JSON.stringify({ title: "founder's own `AgentDispatchPort`" }),
      );
      const { input } = parseToolArguments(['op', '--json-file', path]);
      expect(input['title']).toBe("founder's own `AgentDispatchPort`");
    });

    it('strips a leading UTF-8 byte-order-mark, which --json can never carry (QA)', () => {
      // A shell argument (--json's own payload) cannot begin with a BOM; a file saved by a
      // common Windows/PowerShell/Excel export often does. Without stripping it, --json-file
      // would be silently stricter than the --json payload it exists to replace.
      const path = join(dir, 'bom.json');
      writeFileSync(path, '﻿' + JSON.stringify({ title: 'bom-prefixed' }));
      const { input } = parseToolArguments(['op', '--json-file', path]);
      expect(input['title']).toBe('bom-prefixed');
    });

    it('accumulates with a flag and with --json, exactly as --json does', () => {
      const path = join(dir, 'payload.json');
      writeFileSync(path, JSON.stringify({ scope: 'b' }));
      expect(
        parseToolArguments(['op', '--scope', 'a', '--json-file', path]).input[
          'scope'
        ],
      ).toEqual(['a', 'b']);
    });

    it('refuses a missing file, naming the path rather than a bare ENOENT, under its own error code', () => {
      // JSON_FILE_UNREADABLE, distinct from MISSING_JSON (no path given at all) -- a caller
      // branching on `.code` must be able to tell "you forgot the flag" from "the path you gave
      // exists and reading it failed" (QA, code-review round 4).
      try {
        parseToolArguments(['op', '--json-file', join(dir, 'missing.json')]);
        expect.unreachable('expected parseToolArguments to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(ToolRuntimeError);
        expect((error as ToolRuntimeError).code).toBe('JSON_FILE_UNREADABLE');
        expect((error as ToolRuntimeError).message).toMatch(
          /--json-file could not read/,
        );
      }
    });

    it('refuses invalid JSON and a non-object payload, with the flag named in the message', () => {
      const invalidPath = join(dir, 'invalid.json');
      writeFileSync(invalidPath, '{not json');
      expect(() =>
        parseToolArguments(['op', '--json-file', invalidPath]),
      ).toThrow(/--json-file must contain valid JSON/);

      const arrayPath = join(dir, 'array.json');
      writeFileSync(arrayPath, '[1, 2]');
      expect(() =>
        parseToolArguments(['op', '--json-file', arrayPath]),
      ).toThrow(/--json-file must contain a JSON object/);
    });

    it('requires a path argument', () => {
      expect(() => parseToolArguments(['op', '--json-file'])).toThrow(
        /--json-file requires a file path/,
      );
    });
  });
});

describe('unknown input keys', () => {
  it('accepts exactly the keys the operation validates', async () => {
    const envelope = await strictRuntime().dispatch('strict', {
      value: 'v',
      nested: 'n',
    });

    expect(envelope.status).toBe('success');
  });

  /**
   * 🔴 The defect this exists for. `parentStepId` is a plausible misspelling of an **optional**
   * argument, so every required one is still satisfied and the operation ran happily with the key
   * discarded — reporting success for something the caller did not ask for.
   */
  it('refuses a key the operation does not accept, rather than dropping it', async () => {
    const envelope = await strictRuntime().dispatch('strict', {
      value: 'v',
      parentStepId: 's',
    });

    expect(envelope.status).toBe('error');
    expect(envelope.error?.code).toBe('INVALID_INPUT');
    expect(envelope.exitCode).toBe(TOOL_EXIT_CODES.usage);
  });

  it('names the offending key and lists what is accepted', async () => {
    const envelope = await strictRuntime().dispatch('strict', {
      value: 'v',
      parentStepId: 's',
    });

    // 🔴 Both halves matter: the caller cannot fix a typo from a message that only says
    // "invalid input", and cannot find the right spelling without the accepted names.
    expect(envelope.error?.message).toContain("'parentStepId'");
    expect(envelope.error?.message).toContain("'value'");
    expect(envelope.error?.message).toContain("'nested'");
  });

  it('reports every unknown key at once, not just the first', async () => {
    const envelope = await strictRuntime().dispatch('strict', {
      value: 'v',
      one: '1',
      two: '2',
    });

    expect(envelope.error?.message).toContain("'one'");
    expect(envelope.error?.message).toContain("'two'");
  });

  /**
   * 🔴 A missing *required* argument still reports as missing. Checking unknown keys first would
   * bury the more useful message behind a less useful one whenever a caller mistypes a required
   * argument — both facts are true, and "you left out `value`" is the actionable half.
   */
  it('reports a missing required argument as missing, not as an unknown key', async () => {
    const envelope = await strictRuntime().dispatch('strict', { valu: 'v' });

    expect(envelope.error?.message).toContain("needs a string 'value'");
  });

  /**
   * 🔴 `validate: () => ({})` is how a no-argument operation says so. `skill.seed --force true`
   * used to succeed while ignoring the flag entirely; six such operations now declare an empty
   * hook for exactly this.
   */
  it('refuses any argument to an operation that declares it takes none', async () => {
    const runtime = new CqrsToolRuntime({
      commandBus: new RecordingBus(() => ({ ok: true })),
      queryBus: new RecordingBus(() => null),
      operations: [
        {
          name: 'seed',
          summary: 'Takes nothing',
          kind: 'command',
          validate: () => ({}),
          createRequest: () => ({ type: 'seed' }),
        },
      ],
    });

    const envelope = await runtime.dispatch('seed', { force: true });

    expect(envelope.error?.code).toBe('INVALID_INPUT');
    expect(envelope.error?.message).toContain('takes no arguments');
  });

  /**
   * 🔴 An operation without a `validate` keeps pass-through semantics. There is nothing to derive
   * the accepted names from, and refusing on a guess would break arguments that work.
   */
  it('leaves an operation with no validate hook accepting anything', async () => {
    const { runtime } = createRuntime();

    const envelope = await runtime.dispatch('remember', {
      value: 'v',
      anythingAtAll: true,
    });

    expect(envelope.status).toBe('success');
  });
});

describe('CqrsToolRuntime', () => {
  it('dispatches commands and queries through the provided buses', async () => {
    const { runtime } = createRuntime();
    const remembered = await runtime.dispatch('remember', { value: 'ci' });
    expect(remembered.status).toBe('success');
    const recalled = await runtime.dispatch('recall');
    expect(recalled.data).toBe('ci');
  });

  it('rejects duplicate operation registration', () => {
    const operation: ToolOperationDescriptor = {
      name: 'dup',
      summary: 'duplicate',
      kind: 'command',
      createRequest: () => ({}),
    };
    expect(
      () =>
        new CqrsToolRuntime({
          commandBus: new RecordingBus(() => undefined),
          queryBus: new RecordingBus(() => undefined),
          operations: [operation, operation],
        }),
    ).toThrow('registered more than once');
  });

  it('returns an error envelope for an unknown operation', async () => {
    const { runtime } = createRuntime();
    const envelope = await runtime.dispatch('unknown-operation');
    expect(envelope.status).toBe('error');
    expect(envelope.error?.code).toBe('UNKNOWN_OPERATION');
  });

  it('returns a structured help envelope, including per-topic lookup', () => {
    const { runtime } = createRuntime();
    expect(runtime.helpEnvelope().data).toMatchObject({
      operations: [
        { name: 'recall', kind: 'query' },
        { name: 'remember', kind: 'command' },
      ],
    });
    expect(runtime.helpEnvelope(undefined, 'recall').data).toMatchObject({
      name: 'recall',
    });
    expect(runtime.helpEnvelope(undefined, 'missing').status).toBe('error');
  });
});

describe('CQRS tool transports', () => {
  it('runs a stateless one-shot command/query round trip via runOneShot', async () => {
    const { runtime } = createRuntime();
    const stdout: string[] = [];
    const io = {
      stdout: (line: string) => stdout.push(line),
      stderr: () => undefined,
    };
    await runOneShot(runtime, ['remember', '--value', 'stateless'], io);
    const exitCode = await runOneShot(runtime, ['recall'], io);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout[1]).data).toBe('stateless');
  });

  it('prints CLI help and exits successfully for --help', async () => {
    const { runtime } = createRuntime();
    const stdout: string[] = [];
    const exitCode = await runOneShot(runtime, ['--help'], {
      stdout: (line) => stdout.push(line),
      stderr: () => undefined,
    });
    expect(exitCode).toBe(0);
    expect(stdout[0]).toContain('Usage:');
  });

  it('drives the sidecar JSON-lines transport, including an invalid line', async () => {
    const { runtime } = createRuntime();
    const input = Readable.from([
      '{"operation":"remember","input":{"value":"sidecar"}}\n',
      'not-json\n',
      '{"operation":"recall"}\n',
    ]);
    const { output, text } = createCapturingWritable();
    await runJsonLinesDriver(runtime, input, output);
    const lines = text()
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
    expect(lines[0].status).toBe('success');
    expect(lines[1].error.code).toBe('INVALID_JSON_LINE');
    expect(lines[2].data).toBe('sidecar');
  });

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
 * REPL tab-completion, which is the transport feature nothing was testing.
 *
 * 🔴 It is worth pinning because it is the only part of the runtime a user meets **before** they
 * know the operation names. Completion that silently returns nothing is indistinguishable from an
 * operation list that failed to load.
 */
describe('completeReplLine', () => {
  it('offers the common commands and every operation on an empty line', () => {
    const { runtime } = createRuntime();

    const [candidates] = runtime.completeReplLine('');

    expect(candidates).toEqual(
      expect.arrayContaining(['help', 'exit', 'quit', 'remember', 'recall']),
    );
  });

  it('offers operations as help topics after `help`', () => {
    const { runtime } = createRuntime();

    expect(runtime.completeReplLine('help')[0]).toEqual(
      expect.arrayContaining(['remember', 'recall']),
    );
    expect(runtime.completeReplLine('?')[0]).toEqual(
      expect.arrayContaining(['remember', 'recall']),
    );
  });

  it('narrows help topics by prefix', () => {
    const { runtime } = createRuntime();

    expect(runtime.completeReplLine('help rem')).toEqual([['remember']]);
    expect(runtime.completeReplLine('help zzz')).toEqual([[]]);
  });

  it('completes flags, both at the start of a line and after an operation', () => {
    const { runtime } = createRuntime();

    expect(runtime.completeReplLine('--j')).toEqual([
      ['--json', '--json-file'],
    ]);
    expect(runtime.completeReplLine('remember --')[0]).toEqual(
      expect.arrayContaining(['--help', '--json', '--json-file', '--format']),
    );
  });

  it('narrows operations by prefix', () => {
    const { runtime } = createRuntime();

    expect(runtime.completeReplLine('rec')).toEqual([['recall']]);
  });

  it('offers nothing once an operation has an argument that is not a flag', () => {
    const { runtime } = createRuntime();

    // Completing a *value* would be guessing; an empty list is the honest answer.
    expect(runtime.completeReplLine('remember something')).toEqual([[]]);
  });
});

/**
 * 🔴 **A domain error's own `code` survives into the envelope**, and this is the behaviour that
 * changed on 2026-09-01: anything that was not a `ToolRuntimeError` used to flatten to
 * `HANDLER_FAILURE`, so "not a project", "that id exists" and "the store is broken" all reached a
 * caller as one code, with the message as their only difference — which is exactly what callers are
 * told not to read.
 */
describe('errors from a handler', () => {
  const failWith = (error: unknown) => {
    const bus = new RecordingBus(() => {
      throw error;
    });
    return new CqrsToolRuntime({
      commandBus: bus,
      queryBus: bus,
      operations: [
        {
          name: 'boom',
          summary: 'always fails',
          kind: 'command',
          createRequest: () => ({}),
        },
      ],
    });
  };

  it('keeps a domain error code and its exit code', async () => {
    const domainError = Object.assign(new Error('that id already exists'), {
      code: 'duplicate-document',
      exitCode: 3,
    });

    const envelope = await failWith(domainError).dispatch('boom');

    expect(envelope.status).toBe('error');
    expect(envelope.error?.code).toBe('duplicate-document');
    expect(envelope.exitCode).toBe(3);
  });

  it('falls back to HANDLER_FAILURE only when the error carries no code of its own', async () => {
    const envelope = await failWith(new Error('something broke')).dispatch(
      'boom',
    );

    expect(envelope.error?.code).toBe('HANDLER_FAILURE');
    expect(envelope.error?.message).toBe('something broke');
  });

  it('ignores a blank code rather than reporting an empty one', async () => {
    const envelope = await failWith(
      Object.assign(new Error('broken'), { code: '   ' }),
    ).dispatch('boom');

    expect(envelope.error?.code).toBe('HANDLER_FAILURE');
  });

  it('survives a handler throwing something that is not an Error', async () => {
    const envelope = await failWith('a bare string').dispatch('boom');

    expect(envelope.status).toBe('error');
    expect(envelope.exitCode).toBeGreaterThan(0);
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

/**
 * A sequence that stopped part-way is not a success, and the envelope had no way to say so.
 *
 * 🔴 **The runtime derived `status: 'success'` from "the handler did not throw."** Every resumable
 * `scm` sequence — `branch.open`, `branch.close`, `phase.close`, `feature.close`, `cascade.run` —
 * returns normally when a step refuses, carrying `complete: false` and the step it stopped at. So a
 * nine-step close-out that executed three steps and refused the fourth reported
 * `status: 'success', exitCode: 0`, and a caller reading either was told it had finished.
 *
 * Observed twice on 2026-09-08, on two different operations, which is what localised the fault to
 * the runtime rather than to either handler: `scm.branch.open` refused its cut against a dirty tree
 * and created no branch, and `scm.phase.close` refused a malformed review artifact and opened no
 * pull request. Both exited 0. `d-20260908-scm-branch-open-exits-0-with`.
 *
 * ⚠️ **`success` and `error` were two values for three outcomes** — finished, failed, and stopped
 * part-way and resumable. The third needs a different response from a caller: a failure wants
 * diagnosis, a stop wants resumption. Collapsing them into `error` would have been the same class
 * of fault as reporting them as success.
 */
describe('a handler that reports an incomplete run', () => {
  const sequence = (data: unknown): ToolOperationDescriptor => ({
    name: 'demo.sequence',
    summary: 'a resumable sequence',
    kind: 'command',
    createRequest: () => ({ data }),
  });
  const runtimeFor = (data: unknown) =>
    new CqrsToolRuntime({
      operations: [sequence(data)],
      commandBus: new RecordingBus(() => data),
      queryBus: new RecordingBus(() => data),
    });

  it('reports `incomplete`, not `success`, when the run stopped part-way', async () => {
    const stopped = {
      workflowId: 'w1',
      steps: [{ step: 'cut', outcome: 'refused' }],
      complete: false,
      stoppedAt: 'cut',
    };

    const envelope = await runtimeFor(stopped).dispatch('demo.sequence', {});

    expect(envelope.status).toBe('incomplete');
    // 🔴 Not 0. This is the half that matters to a script or a CI step, which reads the exit code
    // and never the payload. `blocked` already existed in the vocabulary for exactly this.
    expect(envelope.exitCode).toBe(TOOL_EXIT_CODES.blocked);
  });

  it('keeps the payload, because the payload is how a caller resumes', async () => {
    const stopped = {
      complete: false,
      stoppedAt: 'review',
      steps: [{ step: 'review', outcome: 'refused' }],
    };

    const envelope = await runtimeFor(stopped).dispatch('demo.sequence', {});

    // Reporting the stop must not cost the caller the reason for it. An error body alone would say
    // that something refused without saying which step, or what had already run.
    expect(envelope.data).toEqual(stopped);
  });

  it('still reports `success` when the same sequence ran to completion', async () => {
    const finished = {
      workflowId: 'w1',
      steps: [{ step: 'cut', outcome: 'done' }],
      complete: true,
      stoppedAt: null,
    };

    const envelope = await runtimeFor(finished).dispatch('demo.sequence', {});

    // 🔴 The negative control. A rule that reported every sequence incomplete would pass the two
    // assertions above and be worse than the defect it replaced.
    expect(envelope.status).toBe('success');
    expect(envelope.exitCode).toBe(TOOL_EXIT_CODES.success);
  });

  it('leaves a payload that says nothing about completeness alone', async () => {
    // Most operations are not sequences. `complete` is the opt-in, and its absence is not a stop.
    const envelope = await runtimeFor({ rows: [], total: 0 }).dispatch(
      'demo.sequence',
      {},
    );

    expect(envelope.status).toBe('success');
    expect(envelope.exitCode).toBe(TOOL_EXIT_CODES.success);
  });
});
