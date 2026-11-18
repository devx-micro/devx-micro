import { afterEach, describe, expect, it, vi } from 'vitest';

import { BoundedRecording } from './bounded-recording';

const never = (): Promise<void> => new Promise(() => undefined);
const spyStderr = () => {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((
    chunk: unknown,
  ) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  return { lines, restore: () => spy.mockRestore() };
};

describe('BoundedRecording (the recorder wait and breaker shared by every seam)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('awaits work that is merely slow', async () => {
    const bound = new BoundedRecording({ label: 't', timeoutMs: 500 });
    let finished = false;
    await bound.run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      finished = true;
    });
    expect(finished).toBe(true);
    expect(bound.isPaused()).toBe(false);
  });

  it('abandons work that never settles, after the bound, and pauses', async () => {
    const err = spyStderr();
    const bound = new BoundedRecording({
      label: 't',
      timeoutMs: 30,
      cooldownMs: 10_000,
    });
    const started = Date.now();
    await bound.run(never);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(bound.isPaused()).toBe(true);
    err.restore();
  });

  it('swallows work that throws or rejects, without pausing', async () => {
    const bound = new BoundedRecording({ label: 't' });
    await expect(
      bound.run(async () => {
        throw new Error('boom');
      }),
    ).resolves.toBeUndefined();
    await expect(
      bound.run(() => {
        throw new Error('sync boom');
      }),
    ).resolves.toBeUndefined();
    expect(bound.isPaused()).toBe(false);
  });

  it('ends the pause after the cooldown', async () => {
    const err = spyStderr();
    let now = 1000;
    const bound = new BoundedRecording({
      label: 't',
      timeoutMs: 10,
      cooldownMs: 500,
      now: () => now,
    });
    await bound.run(never);
    expect(bound.isPaused()).toBe(true);
    now = 1499;
    expect(bound.isPaused()).toBe(true);
    now = 1500;
    expect(bound.isPaused()).toBe(false);
    err.restore();
  });

  it('a clock stepped backwards ends the pause instead of extending it', async () => {
    const err = spyStderr();
    let now = 100_000;
    const bound = new BoundedRecording({
      label: 't',
      timeoutMs: 10,
      cooldownMs: 10_000,
      now: () => now,
    });
    await bound.run(never);
    now = 5;
    expect(bound.isPaused()).toBe(false);
    err.restore();
  });

  it('a throwing or non-finite clock never throws, and falls back to the wall clock', async () => {
    const err = spyStderr();
    const throwing = new BoundedRecording({
      label: 't',
      timeoutMs: 10,
      now: () => {
        throw new Error('clock');
      },
    });
    await expect(throwing.run(never)).resolves.toBeUndefined();
    expect(() => throwing.isPaused()).not.toThrow();
    const nan = new BoundedRecording({
      label: 't',
      timeoutMs: 10,
      cooldownMs: 10_000,
      now: () => NaN,
    });
    await nan.run(never);
    expect(nan.isPaused()).toBe(true);
    err.restore();
  });

  it('says so on stderr once per trip, naming the seam, not once per in-flight call', async () => {
    const err = spyStderr();
    const bound = new BoundedRecording({
      label: 'seam-x',
      timeoutMs: 20,
      cooldownMs: 10_000,
    });
    await Promise.all([1, 2, 3, 4, 5].map(() => bound.run(never)));
    err.restore();
    const said = err.lines.filter((line) => line.includes('not recording'));
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(
      /^seam-x: the recorder exceeded its bound; not recording for 10000 ms\n$/,
    );
  });

  it('a merely slow call never opens the breaker', async () => {
    const bound = new BoundedRecording({
      label: 't',
      timeoutMs: 300,
      cooldownMs: 10_000,
    });
    await bound.run(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(bound.isPaused()).toBe(false);
  });
});
