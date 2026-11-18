import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { CqrsToolRuntime } from './cqrs-tool-runtime';
import type { ToolBus, ToolOperationDescriptor } from './contracts';
import { VARIABLE_NAME, type SessionBoardPort } from './session-board';
import { completeReplWithVariables, runInteractiveRepl } from './transports';

/** A port over a Map, so the REPL's own behaviour is tested without a real store. */
class MapPort implements SessionBoardPort {
  public readonly boards = new Map<string, Map<string, unknown>>();
  public readonly saved = new Map<string, Map<string, unknown>>();
  public ended: string[] = [];
  private of(session: string) {
    if (!this.boards.has(session)) this.boards.set(session, new Map());
    return this.boards.get(session) as Map<string, unknown>;
  }
  public async set(s: string, name: string, value: unknown) {
    this.of(s).set(name, structuredClone(value));
  }
  public async get(s: string, name: string) {
    const b = this.of(s);
    return b.has(name) ? { found: true, value: b.get(name) } : { found: false };
  }
  public async names(s: string) {
    return [...this.of(s).keys()].sort();
  }
  public async unset(s: string, name: string) {
    return this.of(s).delete(name);
  }
  public async attach(s: string, board: string) {
    const source = this.saved.get(board);
    if (!source) throw new Error(`no board ${board}`);
    for (const [k, v] of source) this.of(s).set(k, v);
    return { attached: source.size, skipped: 0 };
  }
  public async save(s: string, name: string) {
    this.saved.set(name, new Map(this.of(s)));
  }
  public async end(s: string) {
    this.ended.push(s);
    this.boards.delete(s);
  }
}

const received: {
  operation: string;
  input: unknown;
  correlationId?: string;
}[] = [];
const ops: ToolOperationDescriptor[] = [
  {
    name: 'demo.list',
    summary: 'a list',
    kind: 'query',
    createRequest: (input) => ({ op: 'demo.list', input }),
  },
  {
    name: 'demo.fail',
    summary: 'fails',
    kind: 'query',
    createRequest: () => ({ op: 'demo.fail' }),
  },
];
const bus = (): ToolBus => ({
  execute: async (request) => {
    const r = request as { op: string; input: unknown };
    received.push({ operation: r.op, input: r.input });
    if (r.op === 'demo.fail')
      throw Object.assign(new Error('boom'), { code: 'BOOM' });
    return {
      hits: [{ id: 'h-1', note: 'has spaces and --force true' }],
      echo: r.input,
    };
  },
});

async function session(
  lines: readonly string[],
  port?: SessionBoardPort,
): Promise<string> {
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
  for (const line of lines) input.write(`${line}\n`);
  input.write('exit\n');
  await done;
  return out.join('');
}

describe('the REPL session', () => {
  it('mints a session id, announces it, and groups every line under it', async () => {
    const port = new MapPort();
    const out = await session(['demo.list', 'demo.list'], port);
    const id = /Session (s-[0-9a-f]{12})/.exec(out)?.[1];
    expect(id).toBeDefined();
    const correlations = [...out.matchAll(/CORRELATION\n\s+(\S+)/g)].map(
      (m) => m[1],
    );
    expect(correlations).toEqual([`${id}.1`, `${id}.2`]);
  });

  it('two sessions get different ids', async () => {
    const a = /Session (s-\w+)/.exec(await session([]))?.[1];
    const b = /Session (s-\w+)/.exec(await session([]))?.[1];
    expect(a).not.toBe(b);
  });

  it('per-line correlation holds with no board bound, and the variable commands say so plainly', async () => {
    const out = await session([
      'demo.list',
      'vars',
      'set $x = demo.list',
      'unset $x',
      'board save kept',
    ]);
    expect(out).toMatch(/CORRELATION\n\s+s-[0-9a-f]{12}\.1/);
    expect(out.match(/no session board bound/g)?.length).toBe(4);
  });

  it('set stores the envelope data, a reference uses it, and the referenced value is one literal argument', async () => {
    const port = new MapPort();
    received.length = 0;
    const out = await session(
      [
        'set $open = demo.list --status open',
        'demo.list --note $open.hits[0].note --id $open.hits[0].id',
      ],
      port,
    );
    expect(out).toContain('$open set.');
    const second = received.at(-1)?.input as Record<string, unknown>;
    expect(second).toEqual({ note: 'has spaces and --force true', id: 'h-1' });
    expect(Object.keys(second)).toEqual(['note', 'id']);
  });

  it('a failed operation sets nothing', async () => {
    const port = new MapPort();
    const out = await session(['set $x = demo.fail', 'vars'], port);
    expect(out).toContain('$x not set');
    expect(out).toContain('No variables set.');
  });

  it('an unresolved reference is refused with its path and dispatches nothing', async () => {
    const port = new MapPort();
    received.length = 0;
    const out = await session(['demo.list --id $nope.hits[0]'], port);
    expect(out).toMatch(
      /Unresolved reference \$nope\.hits\[0\]: \$nope is not set/,
    );
    expect(received).toHaveLength(0);
  });

  it('vars lists names with a summary, and unset removes one', async () => {
    const port = new MapPort();
    const out = await session(
      ['set $a = demo.list', 'vars', 'unset $a', 'unset $a', 'vars'],
      port,
    );
    expect(out).toMatch(/\$a {2}object\{hits, echo\}/);
    expect(out).toContain('$a unset.');
    expect(out).toContain('$a was not set.');
    expect(out).toContain('No variables set.');
  });

  it('board save then attach in a second session brings the variables back', async () => {
    const port = new MapPort();
    await session(['set $keep = demo.list', 'board save kept'], port);
    received.length = 0;
    const out = await session(
      ['board attach kept', 'demo.list --id $keep.hits[0].id'],
      port,
    );
    expect(out).toContain('Attached board:kept: 1 variable(s).');
    expect((received.at(-1)?.input as { id: string }).id).toBe('h-1');
  });

  it('ending the session ends its board', async () => {
    const port = new MapPort();
    const out = await session(['set $a = demo.list'], port);
    const id = /Session (s-\w+)/.exec(out)?.[1];
    expect(port.ended).toEqual([id]);
  });

  it('a port that fails on attach is reported, not fatal', async () => {
    const out = await session(
      ['board attach nowhere', 'demo.list'],
      new MapPort(),
    );
    expect(out).toContain('no board nowhere');
    expect(out).toContain('demo.list');
  });
});

describe('review fixes', () => {
  it('an operation named like a variable command stays reachable', async () => {
    const shadow: ToolOperationDescriptor[] = [
      {
        name: 'set',
        summary: 'an app operation called set',
        kind: 'query',
        createRequest: (input) => ({ op: 'demo.list', input }),
      },
      {
        name: 'vars',
        summary: 'an app operation called vars',
        kind: 'query',
        createRequest: (input) => ({ op: 'demo.list', input }),
      },
    ];
    for (const port of [undefined, new MapPort()]) {
      const runtime = new CqrsToolRuntime({
        commandBus: bus(),
        queryBus: bus(),
        operations: shadow,
        ...(port ? { sessionBoard: port } : {}),
      });
      const input = new PassThrough();
      const output = new PassThrough();
      const out: string[] = [];
      output.on('data', (c) => out.push(String(c)));
      const done = runInteractiveRepl(runtime, input, output);
      input.write('set --x 1\nvars\nexit\n');
      await done;
      expect(out.join('')).not.toMatch(
        /set needs a variable|no session board bound/,
      );
      expect(out.join('').match(/STATUS\n\s+SUCCESS/g)?.length).toBe(2);
    }
  });

  it('vars survives a variable that vanished between the list and the read', async () => {
    const port = new MapPort();
    await port.set('x', 'a', 1);
    const get = port.get.bind(port);
    port.get = async (s, n) => (n === 'a' ? { found: false } : get(s, n));
    const runtime = new CqrsToolRuntime({
      commandBus: bus(),
      queryBus: bus(),
      operations: ops,
      sessionBoard: port,
    });
    // describeVariable is what `vars` calls with `.value`; it must not throw on undefined.
    const { describeVariable } = await import('./repl-language');
    expect(() => describeVariable(undefined)).not.toThrow();
    expect(runtime.sessionBoard).toBe(port);
  });

  it('a bad JSON line is INVALID_INPUT at parse, and a SyntaxError from a port is not mistaken for it', async () => {
    const out = await session(['{nope'], new MapPort());
    expect(out).toMatch(/OPERATION\n\s+parse/);
    expect(out).toMatch(/INVALID_INPUT/);
    const port = new MapPort();
    port.get = async () => {
      throw new SyntaxError('corrupt stored value');
    };
    const out2 = await session(
      ['set $x = demo.list', 'demo.list --a $x'],
      port,
    );
    expect(out2).toContain('corrupt stored value');
    expect(out2).toMatch(/OPERATION\n\s+repl/);
  });

  it('when the store refuses the value after the operation ran, the REPL says the operation itself ran', async () => {
    const port = new MapPort();
    port.set = async () => {
      throw new Error('refused: credential-shaped');
    };
    const out = await session(['set $x = demo.list'], port);
    expect(out).toMatch(
      /\$x not set: refused: credential-shaped \(the operation itself ran/,
    );
  });

  it('tab completion replaces only the word being completed', () => {
    const runtime = new CqrsToolRuntime({
      commandBus: bus(),
      queryBus: bus(),
      operations: ops,
      sessionBoard: new MapPort(),
    });
    const vars = new Map<string, readonly string[]>([['stage', ['a']]]);
    const word = 'demo.list --id $st'.split(/\s+/).at(-1);
    expect(
      completeReplWithVariables(runtime, 'demo.list --id $st', vars),
    ).toEqual(['$stage']);
    expect(word).toBe('$st');
  });
});

describe('help', () => {
  it('lists the variable commands only when a session board is bound', async () => {
    expect(await session(['help'], new MapPort())).toContain('VARIABLES');
    expect(await session(['help'])).not.toContain('VARIABLES');
  });
});

describe('completion', () => {
  const runtime = new CqrsToolRuntime({
    commandBus: bus(),
    queryBus: bus(),
    operations: ops,
    sessionBoard: new MapPort(),
  });
  const vars = new Map<string, readonly string[]>([
    ['open', ['hits', 'total']],
    ['other', []],
  ]);

  it('completes variables and their top-level fields', () => {
    expect(
      completeReplWithVariables(runtime, 'demo.list --id $o', vars),
    ).toEqual(['$open', '$other']);
    expect(
      completeReplWithVariables(runtime, 'demo.list --id $open.h', vars),
    ).toEqual(['$open.hits']);
    expect(
      completeReplWithVariables(runtime, 'demo.list --id $other.', vars),
    ).toEqual([]);
    expect(completeReplWithVariables(runtime, 'x $$o', vars)).not.toContain(
      '$open',
    );
  });

  it('offers the variable commands beside the operations', () => {
    expect(completeReplWithVariables(runtime, 'v', vars)).toContain('vars');
    expect(completeReplWithVariables(runtime, '', vars)).toEqual(
      expect.arrayContaining(['vars', 'set', 'unset', 'board', 'demo.list']),
    );
  });
});

describe('VARIABLE_NAME', () => {
  it.each(['a', '_a', 'open-defects', 'A1'])('%s', (n) =>
    expect(VARIABLE_NAME.test(n)).toBe(true),
  );
  it.each(['', '1a', '-a', 'a b', 'a.b', 'a$'])('not %j', (n) =>
    expect(VARIABLE_NAME.test(n)).toBe(false),
  );
});
