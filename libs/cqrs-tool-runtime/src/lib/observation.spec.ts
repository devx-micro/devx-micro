import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import type { Clock, ObservationInput, Recorder } from '@devx-micro/observability-port';

import { CqrsToolRuntime } from './cqrs-tool-runtime';
import { TOOL_EXIT_CODES, ToolRuntimeError, type ToolBus, type ToolOperationDescriptor } from './contracts';

class Bus implements ToolBus {
  public constructor(private readonly result: () => unknown | Promise<unknown>) {}
  public async execute(): Promise<unknown> {
    return this.result();
  }
}

class CollectingRecorder implements Recorder {
  public readonly seen: ObservationInput[] = [];
  public async record(input: ObservationInput): Promise<string | undefined> {
    this.seen.push(input);
    return undefined;
  }
}

function jest_spy() {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
  return { lines, restore: () => { process.stderr.write = original; } };
}

const clock = (): Clock => {
  let wall = 0;
  let mono = 100;
  return {
    nowIso: () => `2026-10-12T12:00:0${wall++}.000Z`,
    monotonicMs: () => (mono += 25),
  };
};

const ops: ToolOperationDescriptor[] = [
  { name: 'demo.ok', summary: 's', kind: 'query', createRequest: () => ({}) },
  { name: 'demo.boom', summary: 's', kind: 'command', createRequest: () => ({}) },
  { name: 'demo.stops', summary: 's', kind: 'command', createRequest: () => ({}) },
  { name: 'demo.needs', summary: 's', kind: 'query', validate: (input) => ({ id: String(input['id']) }), createRequest: () => ({}) },
  { name: 'skill.step.start', summary: 's', kind: 'command', observationKind: 'workflow-step', createRequest: () => ({}) },
  { name: 'demo.self', summary: 's', kind: 'command', recordsItself: true, validate: (input) => ({ id: String(input['id']) }), createRequest: () => ({}) },
];

function make(recorder?: Recorder, behaviour: Record<string, () => unknown> = {}) {
  const run = (name: string) => behaviour[name] ?? (() => ({ fine: true }));
  let current = 'demo.ok';
  const bus = new Bus(async () => run(current)());
  const runtime = new CqrsToolRuntime({
    commandBus: bus,
    queryBus: bus,
    operations: ops,
    ...(recorder ? { recorder, clock: clock(), operator: 'mvp' } : {}),
  });
  return {
    runtime,
    dispatch: (name: string, input: Record<string, unknown> = {}) => {
      current = name;
      return runtime.dispatch(name, input, 'corr-1');
    },
  };
}

describe('CqrsToolRuntime observes every dispatch it was given a recorder for (ADR-072 D7)', () => {
  it('records one observation for a successful operation, with timestamps and a monotonic duration', async () => {
    const recorder = new CollectingRecorder();
    const { dispatch } = make(recorder);
    const envelope = await dispatch('demo.ok');
    expect(envelope.status).toBe('success');
    expect(recorder.seen).toHaveLength(1);
    expect(recorder.seen[0]).toMatchObject({
      kind: 'operation',
      operator: 'mvp',
      operation: 'demo.ok',
      beforeTimestamp: '2026-10-12T12:00:00.000Z',
      afterTimestamp: '2026-10-12T12:00:01.000Z',
      durationMs: 25,
      result: { outcome: 'success', evidence: [] },
    });
  });

  it('records a handler failure as a failure with the error code as evidence, never the message', async () => {
    const recorder = new CollectingRecorder();
    const { dispatch } = make(recorder, { 'demo.boom': () => { throw new ToolRuntimeError('STORE_LOCKED', 'the store at /home/x is locked', TOOL_EXIT_CODES.conflict); } });
    const envelope = await dispatch('demo.boom');
    expect(envelope.status).toBe('error');
    expect(recorder.seen[0]?.result).toEqual({ outcome: 'failure', evidence: ['STORE_LOCKED'] });
    expect(JSON.stringify(recorder.seen[0])).not.toContain('/home/x');
  });

  it('records a resumable run that stopped as blocked, with evidence', async () => {
    const recorder = new CollectingRecorder();
    const { dispatch } = make(recorder, { 'demo.stops': () => ({ complete: false, stoppedAt: 'review' }) });
    const envelope = await dispatch('demo.stops');
    expect(envelope.status).toBe('incomplete');
    expect(recorder.seen[0]?.result).toEqual({ outcome: 'blocked', evidence: ['incomplete-run'] });
  });

  it('records a refused input as a failure (INVALID_INPUT), because it is still a unit that ran', async () => {
    const recorder = new CollectingRecorder();
    const { dispatch } = make(recorder);
    const envelope = await dispatch('demo.needs', { id: 'x', stray: 1 });
    expect(envelope.status).toBe('error');
    expect(recorder.seen[0]?.result).toEqual({ outcome: 'failure', evidence: ['INVALID_INPUT'] });
  });

  it('does not record an unknown operation: its name is the caller\'s text, not a registered operation', async () => {
    const recorder = new CollectingRecorder();
    const { dispatch } = make(recorder);
    const envelope = await dispatch('AKIA-not-an-operation');
    expect(envelope.error?.code).toBe('UNKNOWN_OPERATION');
    expect(recorder.seen).toEqual([]);
  });

  it('records the descriptor\'s own kind (skill.step.* are workflow steps, not plain operations)', async () => {
    const recorder = new CollectingRecorder();
    const { dispatch } = make(recorder);
    await dispatch('skill.step.start');
    expect(recorder.seen[0]?.kind).toBe('workflow-step');
  });

  it('never records an argument VALUE (ADR-072 D9): only the names of the keys and the correlation id', async () => {
    const recorder = new CollectingRecorder();
    const { dispatch } = make(recorder);
    await dispatch('demo.needs', { id: 'hunter2hunter2' });
    const text = JSON.stringify(recorder.seen[0]);
    expect(text).not.toContain('hunter2hunter2');
    expect(recorder.seen[0]?.detail).toEqual({ correlationId: 'corr-1', inputKeys: ['id'], inputKeyCount: 1 });
  });

  it('never lets the recorder change the result: a throw or a rejection leaves the envelope untouched (ADR-072 D7)', async () => {
    for (const recorder of [
      { record: () => { throw new Error('sync boom'); } },
      { record: async () => { throw new Error('async boom'); } },
    ] as unknown as Recorder[]) {
      const { dispatch } = make(recorder);
      const envelope = await dispatch('demo.ok');
      expect(envelope.status).toBe('success');
      expect(envelope.data).toEqual({ fine: true });
    }
  });

  it('is unchanged without a recorder: nothing to inject, nothing recorded, same envelope', async () => {
    const { dispatch } = make();
    const envelope = await dispatch('demo.ok');
    expect(envelope).toMatchObject({ operation: 'demo.ok', status: 'success', exitCode: 0, data: { fine: true } });
  });

  it('awaits the recorder before answering, so a one-shot CLI process cannot exit before the write', async () => {
    const order: string[] = [];
    const recorder: Recorder = { record: async () => { await new Promise((r) => setTimeout(r, 10)); order.push('recorded'); return undefined; } };
    const { dispatch } = make(recorder);
    await dispatch('demo.ok');
    order.push('answered');
    expect(order).toEqual(['recorded', 'answered']);
  });

  it('stops waiting for a recorder that never settles, and answers anyway (ADR-072 D7)', async () => {
    const hung: Recorder = { record: () => new Promise(() => undefined) };
    const bus = new Bus(async () => ({ fine: true }));
    const runtime = new CqrsToolRuntime({ commandBus: bus, queryBus: bus, operations: ops, recorder: hung, recordTimeoutMs: 40 });
    const started = Date.now();
    const envelope = await runtime.dispatch('demo.ok', {}, 'corr-1');
    expect(envelope.status).toBe('success');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('still waits for a recorder that is merely slow, within the bound', async () => {
    const slow: Recorder = { record: async () => { await new Promise((r) => setTimeout(r, 20)); order.push('recorded'); return undefined; } };
    const order: string[] = [];
    const bus = new Bus(async () => ({ fine: true }));
    const runtime = new CqrsToolRuntime({ commandBus: bus, queryBus: bus, operations: ops, recorder: slow, recordTimeoutMs: 500 });
    await runtime.dispatch('demo.ok', {}, 'corr-1');
    order.push('answered');
    expect(order).toEqual(['recorded', 'answered']);
  });

  it('answers from a bare one-shot process even when the recorder hangs and nothing else keeps the loop alive', () => {
    // Only a real process can show this: under a test runner something else holds the event loop open. With an unref'd
    // timer node exits silently, with code 0, before the envelope is ever written.
    const runtime = join(__dirname, 'cqrs-tool-runtime');
    const code = `
      const { CqrsToolRuntime } = require(${JSON.stringify(runtime)});
      const bus = { execute: async () => ({ fine: true }) };
      const runtime = new CqrsToolRuntime({
        commandBus: bus, queryBus: bus, recordTimeoutMs: 150,
        operations: [{ name: 'demo.ok', summary: 's', kind: 'query', createRequest: () => ({}) }],
        recorder: { record: () => new Promise(() => undefined) },
      });
      runtime.dispatch('demo.ok', {}, 'c').then((envelope) => process.stdout.write('ANSWERED:' + envelope.status));
    `;
    const output = execFileSync(process.execPath, ['--import', 'tsx', '-e', code], {
      env: { ...process.env, TSX_TSCONFIG_PATH: join(__dirname, '../../../../tsconfig.base.json') },
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(output).toBe('ANSWERED:success');
  });

  it('bounds what it records about the input keys: at most 32 names of at most 64 characters, and the true count', async () => {
    const recorder = new CollectingRecorder();
    const { dispatch } = make(recorder);
    const many = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`.padEnd(200, 'x'), i]));
    await dispatch('demo.needs', { id: 'x', ...many });
    const detail = recorder.seen[0]?.detail as { inputKeys: string[]; inputKeyCount: number };
    expect(detail.inputKeys).toHaveLength(32);
    expect(detail.inputKeys.every((name) => name.length <= 64)).toBe(true);
    expect(detail.inputKeyCount).toBe(501);
  });

  it('never lets a caller-chosen key name make its own observation unrecordable: names are cut by code point and made well-formed', async () => {
    const recorder = new CollectingRecorder();
    const { dispatch } = make(recorder);
    // 63 ASCII characters then an emoji: a cut by UTF-16 unit at 64 leaves a lone high surrogate.
    await dispatch('demo.needs', { id: 'x', ['a'.repeat(63) + '😀']: 1, ['bad\ud800name']: 2 });
    const names = (recorder.seen[0]?.detail as { inputKeys: string[] }).inputKeys;
    for (const name of names) {
      expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(name), JSON.stringify(name)).toBe(false);
      expect(Array.from(name).length).toBeLessThanOrEqual(64);
    }
    expect(names).toContain('a'.repeat(63) + '😀');
    expect(names.some((name) => name.includes('\ufffd'))).toBe(true);
  });

  it('makes the correlation id well-formed too: on HTTP it is caller text', async () => {
    const recorder = new CollectingRecorder();
    const bus = new Bus(async () => ({ fine: true }));
    const runtime = new CqrsToolRuntime({ commandBus: bus, queryBus: bus, operations: ops, recorder });
    await runtime.dispatch('demo.ok', {}, 'corr-\ud800-id');
    const id = (recorder.seen[0]?.detail as { correlationId: string }).correlationId;
    expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(id)).toBe(false);
    expect(id).toBe('corr-\ufffd-id');
  });

  it('stops asking a recorder that just timed out, for a cooldown, so a wedged store costs the bound once and not on every call', async () => {
    let asked = 0;
    const hung: Recorder = { record: () => { asked++; return new Promise(() => undefined); } };
    const bus = new Bus(async () => ({ fine: true }));
    let now = 1_000;
    const runtime = new CqrsToolRuntime({ commandBus: bus, queryBus: bus, operations: ops, recorder: hung, recordTimeoutMs: 30, recordCooldownMs: 10_000, now: () => now });
    const first = Date.now();
    await runtime.dispatch('demo.ok', {}, 'c1');
    expect(Date.now() - first).toBeGreaterThanOrEqual(25);
    expect(asked).toBe(1);

    const second = Date.now();
    await runtime.dispatch('demo.ok', {}, 'c2');
    expect(Date.now() - second).toBeLessThan(25);
    expect(asked).toBe(1);

    now += 10_001; // the cooldown has passed: it tries again
    await runtime.dispatch('demo.ok', {}, 'c3');
    expect(asked).toBe(2);
  });

  it('resumes recording when the wall clock steps back past the cooldown, instead of staying blind', async () => {
    let asked = 0;
    const hung: Recorder = { record: () => { asked++; return new Promise(() => undefined); } };
    const bus = new Bus(async () => ({ fine: true }));
    let now = 1_000_000;
    const runtime = new CqrsToolRuntime({ commandBus: bus, queryBus: bus, operations: ops, recorder: hung, recordTimeoutMs: 20, recordCooldownMs: 10_000, now: () => now });
    await runtime.dispatch('demo.ok', {}, 'c1');
    now -= 3_600_000;
    await runtime.dispatch('demo.ok', {}, 'c2');
    expect(asked).toBe(2);
  });

  it('survives an injected breaker clock that throws', async () => {
    const recorder = new CollectingRecorder();
    const bus = new Bus(async () => ({ fine: true }));
    const runtime = new CqrsToolRuntime({ commandBus: bus, queryBus: bus, operations: ops, recorder, now: () => { throw new Error('clock'); } });
    const envelope = await runtime.dispatch('demo.ok', {}, 'c1');
    expect(envelope.status).toBe('success');
  });

  it('records the key names the caller sent, even when the handler mutates its input', async () => {
    const recorder = new CollectingRecorder();
    const mutating: ToolOperationDescriptor[] = [
      { name: 'demo.mut', summary: 's', kind: 'command', createRequest: (i: Record<string, unknown>) => { i['injected'] = 1; delete i['given']; return {}; } },
    ];
    const bus = new Bus(async () => ({ fine: true }));
    const runtime = new CqrsToolRuntime({ commandBus: bus, queryBus: bus, operations: mutating, recorder });
    await runtime.dispatch('demo.mut', { given: 1, other: 2 }, 'c1');
    expect((recorder.seen[0]?.detail as { inputKeys: string[] }).inputKeys).toEqual(['given', 'other']);
  });

  it('still answers when the input is an exotic object whose keys cannot be read', async () => {
    const recorder = new CollectingRecorder();
    const bus = new Bus(async () => ({ fine: true }));
    const runtime = new CqrsToolRuntime({ commandBus: bus, queryBus: bus, operations: ops, recorder });
    const hostile = new Proxy({}, { ownKeys: () => { throw new Error('x'); } });
    const envelope = await runtime.dispatch('demo.ok', hostile as Record<string, unknown>, 'c1');
    expect(envelope.status).toBe('success');
  });

  it('treats a non-finite breaker clock as the wall clock, so the breaker still opens', async () => {
    let asked = 0;
    const hung: Recorder = { record: () => { asked++; return new Promise(() => undefined); } };
    const bus = new Bus(async () => ({ fine: true }));
    const runtime = new CqrsToolRuntime({ commandBus: bus, queryBus: bus, operations: ops, recorder: hung, recordTimeoutMs: 20, recordCooldownMs: 10_000, now: () => NaN });
    await runtime.dispatch('demo.ok', {}, 'c1');
    await runtime.dispatch('demo.ok', {}, 'c2');
    expect(asked).toBe(1);
  });

  it('says so on stderr once per trip, not once per in-flight call', async () => {
    const hung: Recorder = { record: () => new Promise(() => undefined) };
    const bus = new Bus(async () => ({ fine: true }));
    const runtime = new CqrsToolRuntime({ commandBus: bus, queryBus: bus, operations: ops, recorder: hung, recordTimeoutMs: 20, recordCooldownMs: 10_000 });
    const write = jest_spy();
    try {
      await Promise.all([1, 2, 3, 4, 5].map((n) => runtime.dispatch('demo.ok', {}, `c${n}`)));
    } finally {
      write.restore();
    }
    expect(write.lines.filter((l) => l.includes('not recording')).length).toBe(1);
  });

  it('bounds an oversized correlation id so it cannot push the key names out of the record', async () => {
    const recorder = new CollectingRecorder();
    const bus = new Bus(async () => ({ fine: true }));
    const runtime = new CqrsToolRuntime({ commandBus: bus, queryBus: bus, operations: ops, recorder });
    await runtime.dispatch('demo.ok', { a: 1 }, 'x'.repeat(500_000));
    const detail = recorder.seen[0]?.detail as { correlationId: string; inputKeys: string[] };
    expect(Array.from(detail.correlationId).length).toBe(128);
    expect(detail.inputKeys).toEqual(['a']);
  });

  it('does not open the breaker for a slow-but-healthy recorder, only for one that timed out', async () => {
    let asked = 0;
    const slow: Recorder = { record: async () => { asked++; await new Promise((r) => setTimeout(r, 10)); return undefined; } };
    const bus = new Bus(async () => ({ fine: true }));
    const runtime = new CqrsToolRuntime({ commandBus: bus, queryBus: bus, operations: ops, recorder: slow, recordTimeoutMs: 200, recordCooldownMs: 10_000 });
    await runtime.dispatch('demo.ok', {}, 'c1');
    await runtime.dispatch('demo.ok', {}, 'c2');
    expect(asked).toBe(2);
  });
});

describe('an operation that records its own completion (ADR-072 D4a: a more specific kind replaces the runtime event, never adds one)', () => {
  it('adds no generic event when it succeeds, because its handler recorded the one completion', async () => {
    const recorder = new CollectingRecorder();
    const { dispatch } = make(recorder);
    expect((await dispatch('demo.self', { id: 'x' })).status).toBe('success');
    expect(recorder.seen).toEqual([]);
  });

  it('still records the call as a failure when the handler threw, because then no completion was written', async () => {
    const recorder = new CollectingRecorder();
    const { dispatch } = make(recorder, { 'demo.self': () => { throw new ToolRuntimeError('RECORD_FAILED', 'm', TOOL_EXIT_CODES.failure); } });
    expect((await dispatch('demo.self', { id: 'x' })).status).toBe('error');
    expect(recorder.seen).toHaveLength(1);
    expect(recorder.seen[0]).toMatchObject({ kind: 'operation', operation: 'demo.self', result: { outcome: 'failure', evidence: ['RECORD_FAILED'] } });
  });

  it('still records a refused input as a failure (nothing ran, so nothing recorded itself)', async () => {
    const recorder = new CollectingRecorder();
    const { dispatch } = make(recorder);
    const envelope = await dispatch('demo.self', { id: 'x', stray: 1 });
    expect(envelope.status).toBe('error');
    expect(recorder.seen).toHaveLength(1);
    expect(recorder.seen[0]?.result).toEqual({ outcome: 'failure', evidence: ['INVALID_INPUT'] });
  });

  it('an ordinary operation is still recorded on success (the flag is opt-in)', async () => {
    const recorder = new CollectingRecorder();
    const { dispatch } = make(recorder);
    await dispatch('demo.ok');
    expect(recorder.seen).toHaveLength(1);
  });
});
