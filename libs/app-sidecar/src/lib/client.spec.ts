import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SidecarClient, boundedTail } from './client';

const SERVER = join(__dirname, 'fake-server.fixture.cjs');
const started: SidecarClient[] = [];

function client(
  command = process.execPath,
  args: readonly string[] = [SERVER],
): SidecarClient {
  const next = new SidecarClient({ command, args });
  started.push(next);
  next.start();
  return next;
}

afterEach(async () => {
  await Promise.all(started.splice(0).map((c) => c.stop()));
});

describe('boundedTail', () => {
  it('keeps only the last `limit` characters', () => {
    expect(boundedTail('abcdef', 4)).toBe('cdef');
  });

  it('does not split a UTF-16 surrogate pair straddling the cut point', () => {
    const value = `\u{1F600}${'a'.repeat(9)}`; // pair at index 0-1, cut point at index 1
    const tail = boundedTail(value, 10);
    expect(tail).toBe('a'.repeat(9));
  });
});

describe('SidecarClient', () => {
  it('round-trips a request through the child process', async () => {
    const sidecar = client();
    const envelope = await sidecar.request({
      operation: 'echo',
      input: { a: 1 },
    });
    expect(envelope).toEqual({
      status: 'success',
      data: { operation: 'echo', input: { a: 1 } },
    });
  });

  it('pairs each response with its own request when several are queued', async () => {
    const sidecar = client();
    const [slow, fast] = await Promise.all([
      sidecar.request({ operation: 'slow' }),
      sidecar.request({ operation: 'fast' }),
    ]);
    expect(slow.data).toBe('slow');
    expect(fast.data).toEqual({ operation: 'fast' });
  });

  it('refuses a request before start()', async () => {
    const sidecar = new SidecarClient({ command: process.execPath, args: [] });
    await expect(sidecar.request({ operation: 'x' })).rejects.toThrow(
      'start() must be called',
    );
  });

  it('rejects a request when the command cannot be spawned, instead of crashing the host', async () => {
    const sidecar = client('/nonexistent/sidecar-command', []);
    await expect(sidecar.request({ operation: 'x' })).rejects.toThrow();
  });

  it('rejects the waiting request when the child crashes, then every later one', async () => {
    const sidecar = client();
    await expect(sidecar.request({ operation: 'crash' })).rejects.toThrow(
      /exited unexpectedly \(code=3/,
    );
    await expect(sidecar.request({ operation: 'after' })).rejects.toThrow(
      /exited unexpectedly/,
    );
  });

  it('rejects a request still queued when stop() is called', async () => {
    const sidecar = client();
    const pending = sidecar.request({ operation: 'slow' });
    const queued = sidecar.request({ operation: 'queued' });
    const settled = Promise.allSettled([pending, queued]);
    await sidecar.stop();
    const results = await settled;
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
  });

  it('can be started again after stop()', async () => {
    const sidecar = client();
    await sidecar.stop();
    sidecar.start();
    const envelope = await sidecar.request({ operation: 'again' });
    expect(envelope.status).toBe('success');
  });
});
