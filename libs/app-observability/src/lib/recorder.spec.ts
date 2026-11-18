import {
  isInferenceRecorder,
  noopRecorder,
  startTiming,
  type Clock,
} from './recorder';

const fakeClock = (steps: readonly [string, number][]): Clock => {
  let index = 0;
  return {
    nowIso: () => steps[Math.min(index, steps.length - 1)][0],
    monotonicMs: () => steps[Math.min(index++, steps.length - 1)][1],
  };
};

describe('the recorder port', () => {
  it('the no-op recorder records nothing and returns nothing', async () => {
    await expect(
      noopRecorder.record({ kind: 'operation' } as never),
    ).resolves.toBeUndefined();
  });

  it('measures duration with the monotonic clock, not by subtracting the timestamps', () => {
    // The wall clock steps BACKWARDS (an NTP correction); the monotonic clock does not.
    const timing = startTiming(
      fakeClock([
        ['2026-10-10T12:00:10.000Z', 1000],
        ['2026-10-10T12:00:05.000Z', 1250],
      ]),
    );
    expect(timing.finish()).toEqual({
      beforeTimestamp: '2026-10-10T12:00:10.000Z',
      afterTimestamp: '2026-10-10T12:00:05.000Z',
      durationMs: 250,
    });
  });

  it('omits the duration instead of throwing or recording a negative one when the monotonic clock goes backwards', () => {
    const timing = startTiming(
      fakeClock([
        ['2026-10-10T12:00:00.000Z', 500],
        ['2026-10-10T12:00:01.000Z', 400],
      ]),
    );
    const finished = timing.finish();
    expect(finished).toEqual({
      beforeTimestamp: '2026-10-10T12:00:00.000Z',
      afterTimestamp: '2026-10-10T12:00:01.000Z',
    });
    expect('durationMs' in finished).toBe(false);
  });

  it('never throws on a clock glitch, because timing must not change the observed unit: the duration is omitted', () => {
    for (const steps of [
      [
        ['a', Number.NaN],
        ['b', 5],
      ],
      [
        ['a', 5],
        ['b', Infinity],
      ],
      [
        ['a', 5],
        ['b', Number.NaN],
      ],
    ] as [string, number][][]) {
      const finished = startTiming(fakeClock(steps)).finish();
      expect('durationMs' in finished).toBe(false);
      expect(finished.beforeTimestamp).toBe('a');
    }
  });

  it('omits the duration for readings that are not numbers at all, without throwing', () => {
    for (const reading of [Symbol('s'), BigInt(5), '9', {}, null, undefined]) {
      const finished = startTiming(
        fakeClock([
          ['a', 5],
          ['b', reading as never],
        ]),
      ).finish();
      expect('durationMs' in finished).toBe(false);
    }
  });
});

describe('isInferenceRecorder', () => {
  it('is false for the no-op recorder, undefined, and a recorder with only some of the methods', () => {
    expect(isInferenceRecorder(noopRecorder)).toBe(false);
    expect(isInferenceRecorder(undefined)).toBe(false);
    expect(
      isInferenceRecorder({
        ...noopRecorder,
        storeArtifact: async () => ({ ref: '1-' + 'a'.repeat(32) }),
      } as never),
    ).toBe(false);
  });
  it('is true only when all three inference methods exist', () => {
    const full = {
      ...noopRecorder,
      storeArtifact: async () => ({ withheld: 'x' }),
      storeContract: async () => ({ withheld: 'x' }),
      recordIteration: async () => undefined,
    };
    expect(isInferenceRecorder(full as never)).toBe(true);
  });
});
