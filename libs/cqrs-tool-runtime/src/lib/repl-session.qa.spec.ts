import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { CqrsToolRuntime } from './cqrs-tool-runtime';
import type { ToolBus, ToolOperationDescriptor } from './contracts';
import { bindOperationLine, describeVariable } from './repl-language';
import type { SessionBoardPort } from './session-board';
import { completeReplWithVariables, runInteractiveRepl } from './transports';

/** QA probes for REPL sessions and variables. Each states the behaviour that SHOULD hold. */
class MapPort implements SessionBoardPort {
  public readonly boards = new Map<string, Map<string, unknown>>();
  public ended: string[] = [];
  public failGetAfterSet = false;
  private armed = false;
  private of(s: string) {
    if (!this.boards.has(s)) this.boards.set(s, new Map());
    return this.boards.get(s) as Map<string, unknown>;
  }
  public async set(s: string, n: string, v: unknown) {
    this.of(s).set(n, structuredClone(v));
    if (this.failGetAfterSet) this.armed = true;
  }
  public async get(s: string, n: string) {
    if (this.armed) throw new Error('store went away');
    const b = this.of(s);
    return b.has(n) ? { found: true, value: b.get(n) } : { found: false };
  }
  public async names(s: string) {
    return [...this.of(s).keys()].sort();
  }
  public async unset(s: string, n: string) {
    return this.of(s).delete(n);
  }
  public async attach() {
    return { attached: 0, skipped: 0 };
  }
  public async save() {
    /* */
  }
  public async end(s: string) {
    this.ended.push(s);
  }
}

const received: { operation: string; input: unknown }[] = [];
const ops: ToolOperationDescriptor[] = [
  {
    name: 'demo.list',
    summary: 'a list',
    kind: 'query',
    createRequest: (input) => ({ op: 'demo.list', input }),
  },
];
const bus = (): ToolBus => ({
  execute: async (request) => {
    const r = request as { op: string; input: unknown };
    received.push({ operation: r.op, input: r.input });
    return { echo: r.input };
  },
});
async function session(
  lines: readonly string[],
  port?: SessionBoardPort,
): Promise<string> {
  received.length = 0;
  const runtime = new CqrsToolRuntime({
    commandBus: bus(),
    queryBus: bus(),
    operations: ops,
    ...(port ? { sessionBoard: port } : {}),
  });
  const input = new PassThrough();
  const output = new PassThrough();
  const out: string[] = [];
  output.on('data', (c) => out.push(String(c)));
  const done = runInteractiveRepl(runtime, input, output);
  for (const l of lines) input.write(`${l}\n`);
  input.write('exit\n');
  await done;
  return out.join('');
}
const lookup = (vars: Record<string, unknown>) => async (n: string) =>
  n in vars ? { found: true, value: vars[n] } : { found: false };

describe('QA: apps WITHOUT a session board must behave as before', () => {
  it('QA-1 a flag value like $5 or a JSON string like $HOME reaches the operation literally', async () => {
    await session([
      'demo.list --price $5',
      '{"operation":"demo.list","input":{"home":"$HOME"}}',
    ]);
    expect(received.map((r) => r.input)).toEqual([
      { price: '$5' },
      { home: '$HOME' },
    ]);
  });
  it('QA-2 tab completion does not advertise variable commands when none are available', () => {
    const runtime = new CqrsToolRuntime({
      commandBus: bus(),
      queryBus: bus(),
      operations: ops,
    });
    const offered = completeReplWithVariables(runtime, '', new Map());
    expect(offered).not.toContain('set');
    expect(offered).not.toContain('vars');
  });
});

describe('QA: reference binding', () => {
  it('QA-3 an error from the argument parser never shows the internal NUL placeholder', async () => {
    for (const line of ['demo.list $x', 'demo.list --json-file $x']) {
      const err = await bindOperationLine(
        line,
        lookup({ x: '/tmp/nope' }),
      ).then(
        () => '',
        (e: Error) => e.message,
      );
      // eslint-disable-next-line no-control-regex
      expect(err, line).not.toMatch(/\u0000|ref-/);
      expect(err, line).not.toBe('');
    }
  });
  it('QA-4 a repeated flag mixing a reference to an array and a literal accumulates like literals do', async () => {
    const viaRef = await bindOperationLine(
      'demo.list --scope $a --scope c',
      lookup({ a: ['a', 'b'] }),
    );
    const viaLiterals = await bindOperationLine(
      'demo.list --scope a --scope b --scope c',
      lookup({}),
    );
    expect(viaRef.input).toEqual(viaLiterals.input);
  });
  it('QA-5 in a JSON line the operation cannot be a variable (the flag form refuses it)', async () => {
    await expect(
      bindOperationLine('{"operation":"$op"}', lookup({ op: 'board.reap' })),
    ).rejects.toThrow();
  });
});

describe('QA: display safety', () => {
  it('QA-6 describeVariable never emits a raw newline or control character taken from data', () => {
    // eslint-disable-next-line no-control-regex
    const controlCharacter = /[\u0000-\u001f]/;
    expect(describeVariable({ 'a\n$evil  object{}': 1 })).not.toMatch(
      controlCharacter,
    );
  });
  it('QA-7 completion offers only fields that are valid reference segments', () => {
    const runtime = new CqrsToolRuntime({
      commandBus: bus(),
      queryBus: bus(),
      operations: ops,
      sessionBoard: new MapPort(),
    });
    const offered = completeReplWithVariables(
      runtime,
      '$x.',
      new Map([['x', ['ok', 'has space', 'a.b']]]),
    );
    expect(offered).toEqual(['$x.ok']);
  });
});

describe('QA: failures after a successful set', () => {
  it('QA-8 if the set landed but the index refresh fails, the user is still told the variable was set', async () => {
    const port = new MapPort();
    port.failGetAfterSet = true;
    const out = await session(['set $x = demo.list'], port);
    expect(port.boards.size).toBe(1);
    expect(out).toContain('$x set.');
  });
  it('QA-9 Ctrl-D (end of input without exit) also ends the session board', async () => {
    const port = new MapPort();
    const runtime = new CqrsToolRuntime({
      commandBus: bus(),
      queryBus: bus(),
      operations: ops,
      sessionBoard: port,
    });
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const done = runInteractiveRepl(runtime, input, output);
    input.write('set $x = demo.list\n');
    input.end();
    await done;
    expect(port.ended).toHaveLength(1);
  });
});
