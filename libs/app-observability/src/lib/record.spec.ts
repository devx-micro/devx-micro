import { validateObservation, type ObservationRecord } from './record';

const ok: ObservationRecord = {
  schemaVersion: 1,
  kind: 'operation',
  operator: 'my-tool',
  operation: 'item.catalog',
  beforeTimestamp: '2026-10-10T12:00:00.000Z',
  afterTimestamp: '2026-10-10T12:00:01.000Z',
  durationMs: 1000,
  result: { outcome: 'success', evidence: [] },
};

describe('validateObservation', () => {
  it('accepts a minimal success with no evidence and no model', () => {
    expect(validateObservation(ok)).toEqual([]);
  });

  it('requires evidence for a failure or a block, but not for a success or a skip', () => {
    expect(
      validateObservation({
        ...ok,
        result: { outcome: 'failure', evidence: [] },
      }),
    ).toEqual([expect.stringContaining('evidence')]);
    expect(
      validateObservation({
        ...ok,
        result: { outcome: 'blocked', evidence: [] },
      }),
    ).toHaveLength(1);
    expect(
      validateObservation({
        ...ok,
        result: { outcome: 'failure', evidence: ['TimeoutError'] },
      }),
    ).toEqual([]);
    expect(
      validateObservation({
        ...ok,
        result: { outcome: 'skipped', evidence: [] },
      }),
    ).toEqual([]);
  });

  it('rejects a duration or latency that is negative or not finite (absent is omitted, never zero-filled)', () => {
    for (const bad of [-1, Number.NaN, Infinity]) {
      expect(validateObservation({ ...ok, durationMs: bad })).toEqual([
        expect.stringContaining('durationMs'),
      ]);
      expect(validateObservation({ ...ok, latencyMs: bad })).toEqual([
        expect.stringContaining('latencyMs'),
      ]);
    }
    const withoutDuration = Object.fromEntries(
      Object.entries(ok).filter(([key]) => key !== 'durationMs'),
    );
    expect(validateObservation(withoutDuration)).toEqual([]);
  });

  it('rejects an unknown schema version, kind, outcome, route and unparseable timestamps', () => {
    expect(validateObservation({ ...ok, schemaVersion: 2 } as never)).toEqual([
      expect.stringContaining('schemaVersion'),
    ]);
    expect(validateObservation({ ...ok, kind: 'job' } as never)).toEqual([
      expect.stringContaining('kind'),
    ]);
    expect(
      validateObservation({
        ...ok,
        result: { outcome: 'ok', evidence: [] },
      } as never),
    ).toEqual([expect.stringContaining('outcome')]);
    expect(
      validateObservation({
        ...ok,
        model: { provider: 'p', modelId: 'm', route: 'edge' },
      } as never),
    ).toEqual([expect.stringContaining('route')]);
    expect(
      validateObservation({ ...ok, beforeTimestamp: 'yesterday' }),
    ).toEqual([expect.stringContaining('beforeTimestamp')]);
  });

  it('rejects an empty confidence object, an out-of-range value, and iterations that are not whole numbers', () => {
    expect(
      validateObservation({ ...ok, result: { ...ok.result, confidence: {} } }),
    ).toEqual([expect.stringContaining('confidence')]);
    expect(
      validateObservation({
        ...ok,
        result: { ...ok.result, confidence: { derived: 1.5 } },
      }),
    ).toEqual([expect.stringContaining('confidence')]);
    expect(
      validateObservation({
        ...ok,
        result: { ...ok.result, confidence: { derived: 1, selfReported: 0.2 } },
      }),
    ).toEqual([]);
    expect(
      validateObservation({ ...ok, result: { ...ok.result, iterations: 1.5 } }),
    ).toEqual([expect.stringContaining('iterations')]);
  });

  it('requires every ref to be a content id and `external` to be exactly true when present', () => {
    expect(
      validateObservation({ ...ok, refs: { input: 'not-an-id' } }),
    ).toEqual([expect.stringContaining('refs')]);
    expect(
      validateObservation({ ...ok, refs: { input: '1-' + 'a'.repeat(32) } }),
    ).toEqual([]);
    expect(validateObservation({ ...ok, external: false } as never)).toEqual([
      expect.stringContaining('external'),
    ]);
    expect(validateObservation({ ...ok, external: true })).toEqual([]);
  });

  it('requires a non-empty operator and operation', () => {
    expect(validateObservation({ ...ok, operator: '' })).toEqual([
      expect.stringContaining('operator'),
    ]);
    expect(validateObservation({ ...ok, operation: ' ' })).toEqual([
      expect.stringContaining('operation'),
    ]);
  });

  it('returns problems instead of throwing for a malformed record or result', () => {
    expect(validateObservation(undefined as never)).toEqual([
      expect.stringContaining('object'),
    ]);
    expect(validateObservation(null as never)).toEqual([
      expect.stringContaining('object'),
    ]);
    expect(validateObservation({ ...ok, result: undefined } as never)).toEqual([
      expect.stringContaining('result'),
    ]);
    expect(
      validateObservation({ ...ok, result: { outcome: 'failure' } } as never),
    ).not.toEqual([]);
  });

  it('keeps the field list closed: unknown fields are rejected at every level', () => {
    expect(validateObservation({ ...ok, foo: 1 } as never)).toEqual([
      expect.stringContaining('foo'),
    ]);
    expect(
      validateObservation({ ...ok, result: { ...ok.result, foo: 1 } } as never),
    ).toEqual([expect.stringContaining('foo')]);
    expect(
      validateObservation({
        ...ok,
        model: { provider: 'p', modelId: 'm', route: 'local', foo: 1 },
      } as never),
    ).toEqual([expect.stringContaining('foo')]);
    expect(
      validateObservation({
        ...ok,
        result: { ...ok.result, confidence: { derived: 1, foo: 1 } },
      } as never),
    ).toEqual([expect.stringContaining('foo')]);
  });

  it('checks the shape of refs, detail, withheld, evidence and escalated', () => {
    const id = '1-' + 'a'.repeat(32);
    expect(validateObservation({ ...ok, refs: [id] } as never)).not.toEqual([]);
    expect(validateObservation({ ...ok, refs: null } as never)).not.toEqual([]);
    expect(validateObservation({ ...ok, detail: [] } as never)).not.toEqual([]);
    expect(validateObservation({ ...ok, detail: 'x' } as never)).not.toEqual(
      [],
    );
    expect(validateObservation({ ...ok, detail: { a: 1 } })).toEqual([]);
    expect(
      validateObservation({
        ...ok,
        result: { outcome: 'failure', evidence: 'abc' },
      } as never),
    ).not.toEqual([]);
    expect(
      validateObservation({
        ...ok,
        result: { outcome: 'failure', evidence: [1, {}] },
      } as never),
    ).not.toEqual([]);
    expect(
      validateObservation({
        ...ok,
        result: { outcome: 'failure', evidence: [''] },
      } as never),
    ).not.toEqual([]);
    expect(
      validateObservation({
        ...ok,
        result: { ...ok.result, escalated: 'yes' },
      } as never),
    ).not.toEqual([]);
    expect(
      validateObservation({
        ...ok,
        model: { provider: 'p', modelId: 'm', route: 'local', version: 5 },
      } as never),
    ).not.toEqual([]);
    expect(
      validateObservation({
        ...ok,
        refs: { input: id },
        withheld: { input: 'secret' },
      }),
    ).toEqual([]);
    expect(
      validateObservation({ ...ok, withheld: { input: 'secret' } }),
    ).toEqual([expect.stringContaining('withheld')]);
    // `detail` and `evidence` belong to the record itself, so they can be withheld without a ref.
    expect(
      validateObservation({
        ...ok,
        result: { ...ok.result, evidence: ['withheld: api-key'] },
        withheld: { detail: 'secret: jwt', evidence: 'secret: api-key' },
      }),
    ).toEqual([]);
    // A claim that the detail was withheld must agree with the record: it cannot also carry that detail.
    expect(
      validateObservation({
        ...ok,
        detail: { a: 1 },
        withheld: { detail: 'redacted: jwt' },
      }),
    ).toEqual([expect.stringContaining('withheld.detail')]);
    // ...unless the reason names the properties that were dropped, which is a PARTIAL redaction: the rest survives.
    expect(
      validateObservation({
        ...ok,
        detail: { a: 1 },
        withheld: { detail: 'redacted: jwt (token)' },
      }),
    ).toEqual([]);
    expect(
      validateObservation({
        ...ok,
        detail: { a: 1 },
        withheld: { detail: 'redacted: jwt ()' },
      }),
    ).toEqual([expect.stringContaining('withheld.detail')]);
    // The named properties must really be absent from the detail that is present.
    expect(
      validateObservation({
        ...ok,
        detail: { token: 'x' },
        withheld: { detail: 'redacted: jwt (token)' },
      }),
    ).toEqual([expect.stringContaining('withheld.detail')]);
    expect(
      validateObservation({
        ...ok,
        detail: { a: 1 },
        withheld: { detail: 'redacted: jwt (token, <unnamed>)' },
      }),
    ).toEqual([]);
    // Likewise evidence: a claim that it was withheld needs a withheld marker among the entries, not raw text.
    expect(
      validateObservation({
        ...ok,
        result: { ...ok.result, evidence: ['raw text'] },
        withheld: { evidence: 'redacted: jwt' },
      }),
    ).toEqual([expect.stringContaining('withheld.evidence')]);
    expect(
      validateObservation({
        ...ok,
        result: { ...ok.result, evidence: ['withheld: jwt', 'TimeoutError'] },
        withheld: { evidence: 'redacted: jwt' },
      }),
    ).toEqual([]);
    expect(
      validateObservation({
        ...ok,
        refs: { input: id },
        withheld: { input: 5 },
      } as never),
    ).not.toEqual([]);
  });

  it('requires UTC ISO-8601 timestamps that exist, but not that they are in order', () => {
    for (const bad of [
      '2026',
      'Oct 10 2026',
      '2026-10-10',
      '2026-10-10T00:00:00',
      '2026-10-10T00:00:00+05:00',
      '2026-02-31T00:00:00Z',
      '2026-10-10T24:00:00Z',
    ]) {
      expect(validateObservation({ ...ok, beforeTimestamp: bad })).toEqual([
        expect.stringContaining('beforeTimestamp'),
      ]);
    }
    expect(
      validateObservation({
        ...ok,
        beforeTimestamp: '2026-10-10T12:00:00Z',
        afterTimestamp: '2026-10-10T12:00:00.5Z',
      }),
    ).toEqual([]);
    // The wall clock can step: a unit that ran correctly may have after < before, and it must still be recordable.
    expect(
      validateObservation({
        ...ok,
        beforeTimestamp: '2026-10-10T12:00:01.000Z',
        afterTimestamp: '2026-10-10T12:00:00.000Z',
      }),
    ).toEqual([]);
  });

  it('never throws, even for a getter that throws or a proxy that does', () => {
    const throwing = { ...ok };
    Object.defineProperty(throwing, 'kind', {
      enumerable: true,
      get: () => {
        throw new Error('boom');
      },
    });
    expect(validateObservation(throwing)).toEqual([
      expect.stringContaining('boom'),
    ]);
    const proxy = new Proxy(
      { ...ok },
      {
        ownKeys: () => {
          throw new Error('trap');
        },
      },
    );
    expect(validateObservation(proxy)).toEqual([
      expect.stringContaining('trap'),
    ]);
  });

  it('only calls a record valid if it can be hashed: valid implies recordable', () => {
    const holes = {
      ...ok,
      result: { outcome: 'success', evidence: new Array(3) },
    };
    expect(validateObservation(holes)).not.toEqual([]);
    expect(validateObservation({ ...ok, operator: 'my-tool\ud800' })).toEqual([
      expect.stringContaining('surrogate'),
    ]);
    expect(
      validateObservation({ ...ok, detail: { when: new Date(0) } }),
    ).toEqual([expect.stringContaining('plain')]);
    expect(validateObservation({ ...ok, detail: { n: Number.NaN } })).toEqual([
      expect.stringContaining('cannot be represented'),
    ]);
    const loop: Record<string, unknown> = {};
    loop['self'] = loop;
    expect(validateObservation({ ...ok, detail: loop })).toEqual([
      expect.stringContaining('cycle'),
    ]);
    const inherited = Object.assign(
      Object.create({ kind: 'operation' }),
      Object.fromEntries(Object.entries(ok).filter(([key]) => key !== 'kind')),
    );
    expect(validateObservation(inherited)).not.toEqual([]);
  });

  it('still never throws when what is thrown cannot be turned into text', () => {
    const hostile = [
      Object.create(null),
      {
        toString: () => {
          throw new Error('x');
        },
      },
      Symbol('s'),
      undefined,
      null,
    ];
    for (const thrown of hostile) {
      const throwing = { ...ok };
      Object.defineProperty(throwing, 'kind', {
        enumerable: true,
        get: () => {
          throw thrown;
        },
      });
      expect(validateObservation(throwing)).toEqual([
        expect.stringContaining('could not be read'),
      ]);
    }
  });
});
