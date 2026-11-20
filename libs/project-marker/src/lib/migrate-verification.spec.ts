import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkspaceError } from './marker';
import { migrateAppState } from './migrate';

/**
 * 🔴 These cases prove the ORDER: copy, verify, and only then remove.
 *
 * A real `cp` does not produce a bad copy on demand, so it is replaced here by one that copies and
 * then damages the result. If verification ran after removal, or not at all, the source would be
 * gone by the time the damage was found; every case below asserts it is still there, unchanged.
 */
const real = vi.hoisted(() => ({
  cp: undefined as unknown as typeof import('node:fs/promises').cp,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  real.cp = actual.cp;
  return { ...actual, cp: vi.fn(actual.cp) };
});

const realCp: typeof fsPromises.cp = (...args) => real.cp(...args);

let base: string;
let from: string;
let to: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'project-marker-verify-'));
  from = join(base, 'old');
  to = join(base, 'new');
  mkdirSync(join(from, 'nested'), { recursive: true });
  writeFileSync(join(from, 'CURRENT'), 'MANIFEST-000001\n');
  writeFileSync(join(from, 'nested', 'deep.ldb'), 'nested payload');
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  vi.mocked(fsPromises.cp).mockReset();
  vi.mocked(fsPromises.cp).mockImplementation(realCp);
});

const sourceIsIntact = () => {
  expect(readFileSync(join(from, 'CURRENT'), 'utf8')).toBe('MANIFEST-000001\n');
  expect(readFileSync(join(from, 'nested', 'deep.ldb'), 'utf8')).toBe(
    'nested payload',
  );
};

describe('a copy that does not match is refused, and the source is kept', () => {
  it('refuses a copy with the right names but different bytes', async () => {
    vi.mocked(fsPromises.cp).mockImplementationOnce(async (source, target) => {
      await realCp(source, target, { recursive: true });
      // Same length, different content: a count or a size check would pass this.
      writeFileSync(
        join(String(target), 'nested', 'deep.ldb'),
        'NESTED PAYLOAD',
      );
    });

    const failure = await migrateAppState(from, to).catch((error) => error);

    expect(failure).toBeInstanceOf(WorkspaceError);
    expect((failure as Error).message).toMatch(/deep\.ldb differs/);
    expect((failure as Error).message).toMatch(/left untouched/);
    sourceIsIntact();
  });

  it('refuses a copy that is missing a file', async () => {
    vi.mocked(fsPromises.cp).mockImplementationOnce(async (source, target) => {
      await realCp(source, target, { recursive: true });
      rmSync(join(String(target), 'CURRENT'));
    });

    const failure = await migrateAppState(from, to).catch((error) => error);

    expect(failure).toBeInstanceOf(WorkspaceError);
    expect((failure as Error).message).toMatch(/has 2 file\(s\).*has 1/);
    sourceIsIntact();
  });

  it('refuses a copy that gained a file', async () => {
    vi.mocked(fsPromises.cp).mockImplementationOnce(async (source, target) => {
      await realCp(source, target, { recursive: true });
      writeFileSync(join(String(target), 'stray'), '');
    });

    await expect(migrateAppState(from, to)).rejects.toThrow(WorkspaceError);
    sourceIsIntact();
  });

  it('removes the source only after a copy that matches', async () => {
    await expect(migrateAppState(from, to)).resolves.toMatchObject({
      files: 2,
    });
    expect(existsSync(from)).toBe(false);
  });
});
