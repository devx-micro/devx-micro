import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
 * 🔴 These cases prove the ORDER: copy, verify, and only then remove; and they prove what is left
 * behind when a step fails.
 *
 * A real `cp` does not produce a bad copy on demand, and a real `rm` does not fail on demand, so
 * both are replaced here by versions that can. If verification ran after removal, or not at all,
 * the source would be gone by the time the damage was found; every failure case below asserts it
 * is still there, unchanged.
 */
const real = vi.hoisted(() => ({
  cp: undefined as unknown as typeof import('node:fs/promises').cp,
  rm: undefined as unknown as typeof import('node:fs/promises').rm,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  real.cp = actual.cp;
  real.rm = actual.rm;
  return { ...actual, cp: vi.fn(actual.cp), rm: vi.fn(actual.rm) };
});

const realCp: typeof fsPromises.cp = (...args) => real.cp(...args);
const realRm: typeof fsPromises.rm = (...args) => real.rm(...args);

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
  vi.mocked(fsPromises.rm).mockReset();
  vi.mocked(fsPromises.rm).mockImplementation(realRm);
});

const sourceIsIntact = () => {
  expect(readFileSync(join(from, 'CURRENT'), 'utf8')).toBe('MANIFEST-000001\n');
  expect(readFileSync(join(from, 'nested', 'deep.ldb'), 'utf8')).toBe(
    'nested payload',
  );
};

const copyThen = (damage: (target: string) => void) =>
  vi.mocked(fsPromises.cp).mockImplementationOnce(async (source, target) => {
    await realCp(source, target, { recursive: true });
    damage(String(target));
  });

describe('a copy that does not match is refused, and the source is kept', () => {
  it('refuses a copy with the right names but different bytes', async () => {
    // Same length, different content: a count or a size check would pass this.
    copyThen((target) =>
      writeFileSync(join(target, 'nested', 'deep.ldb'), 'NESTED PAYLOAD'),
    );

    const failure = await migrateAppState(from, to).catch((error) => error);

    expect(failure).toBeInstanceOf(WorkspaceError);
    expect((failure as Error).message).toMatch(/deep\.ldb differs/);
    expect((failure as Error).message).toMatch(/left untouched/);
    sourceIsIntact();
  });

  it('refuses a copy that is missing a file', async () => {
    copyThen((target) => rmSync(join(target, 'CURRENT')));

    const failure = await migrateAppState(from, to).catch((error) => error);

    expect(failure).toBeInstanceOf(WorkspaceError);
    expect((failure as Error).message).toMatch(/has 2 file\(s\).*has 1/);
    sourceIsIntact();
  });

  it('refuses a copy that gained a file', async () => {
    copyThen((target) => writeFileSync(join(target, 'stray'), ''));

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

/**
 * 🔴 A failed migration must be retryable. A partial copy left in a destination this call created
 * makes the retry refuse with "already contains N file(s)", so the call removes what it created.
 */
describe('what a failed migration leaves behind', () => {
  it('removes a destination it created, so a retry succeeds', async () => {
    copyThen((target) =>
      writeFileSync(join(target, 'CURRENT'), 'XXXXXXXXXXXXXXXX'),
    );

    const failure = await migrateAppState(from, to).catch((error) => error);

    expect(failure).toBeInstanceOf(WorkspaceError);
    expect((failure as Error).message).toMatch(/was removed/);
    expect(existsSync(to)).toBe(false);
    sourceIsIntact();
    await expect(migrateAppState(from, to)).resolves.toMatchObject({
      files: 2,
    });
  });

  it('leaves a destination that existed before alone, and says so', async () => {
    mkdirSync(to);
    copyThen((target) =>
      writeFileSync(join(target, 'CURRENT'), 'XXXXXXXXXXXXXXXX'),
    );

    const failure = await migrateAppState(from, to).catch((error) => error);

    expect(failure).toBeInstanceOf(WorkspaceError);
    expect((failure as Error).message).toMatch(
      /existed before.*left as it is/s,
    );
    expect(existsSync(to)).toBe(true);
    expect(readdirSync(to).sort()).toEqual(['CURRENT', 'nested']);
    sourceIsIntact();
  });

  it('reports a failing copy as a WorkspaceError, and cleans up', async () => {
    vi.mocked(fsPromises.cp).mockImplementationOnce(async (source, target) => {
      await realCp(source, target, { recursive: true });
      throw Object.assign(new Error('ENOSPC: no space left on device'), {
        code: 'ENOSPC',
      });
    });

    const failure = await migrateAppState(from, to).catch((error) => error);

    expect(failure).toBeInstanceOf(WorkspaceError);
    expect((failure as Error).message).toMatch(/Copying .* failed: ENOSPC/);
    expect(existsSync(to)).toBe(false);
    sourceIsIntact();
  });

  it('says the copy is complete when only removing the source fails', async () => {
    vi.mocked(fsPromises.rm).mockImplementationOnce(async () => {
      throw Object.assign(new Error('EACCES: permission denied'), {
        code: 'EACCES',
      });
    });

    const failure = await migrateAppState(from, to).catch((error) => error);

    expect(failure).toBeInstanceOf(WorkspaceError);
    expect((failure as Error).message).toMatch(
      /complete and verified.*removing .* failed: EACCES/s,
    );
    // The verified copy is kept: it is the only copy guaranteed whole.
    expect(readFileSync(join(to, 'CURRENT'), 'utf8')).toBe('MANIFEST-000001\n');
    expect(readFileSync(join(to, 'nested', 'deep.ldb'), 'utf8')).toBe(
      'nested payload',
    );
  });
});

describe('when cleaning up fails too', () => {
  it('says the destination could not be removed, so a person removes it before retrying', async () => {
    copyThen((target) =>
      writeFileSync(join(target, 'CURRENT'), 'XXXXXXXXXXXXXXXX'),
    );
    vi.mocked(fsPromises.rm).mockImplementationOnce(async () => {
      throw new Error('EBUSY: resource busy or locked');
    });

    const failure = await migrateAppState(from, to).catch((error) => error);

    expect(failure).toBeInstanceOf(WorkspaceError);
    expect((failure as Error).message).toMatch(
      /could not be removed \(EBUSY.*\); remove it before retrying/,
    );
    sourceIsIntact();
  });
});

describe('a failure that is not an Error', () => {
  it('is still reported as a WorkspaceError, with its value as the reason', async () => {
    vi.mocked(fsPromises.cp).mockImplementationOnce(() =>
      Promise.reject('disk went away'),
    );

    const failure = await migrateAppState(from, to).catch((error) => error);

    expect(failure).toBeInstanceOf(WorkspaceError);
    expect((failure as Error).message).toMatch(/failed: disk went away/);
    expect(existsSync(to)).toBe(false);
    sourceIsIntact();
  });
});
