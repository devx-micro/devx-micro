import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WorkspaceError } from './marker';
import { migrateAppState } from './migrate';

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'project-marker-migrate-'));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

/**
 * A stand-in for an embedded database directory: data files AND the bookkeeping that makes them
 * readable (a LevelDB-style store keeps both side by side).
 */
const seedStore = (path: string) => {
  mkdirSync(join(path, 'nested'), { recursive: true });
  writeFileSync(join(path, 'CURRENT'), 'MANIFEST-000001\n');
  writeFileSync(join(path, 'LOCK'), '');
  writeFileSync(join(path, '000003.log'), 'a record');
  writeFileSync(join(path, 'nested', 'deep.ldb'), 'nested payload');
};

describe('migrating app state', () => {
  it('moves every file, including the bookkeeping, and removes the source', async () => {
    const from = join(base, 'old');
    const to = join(base, 'new');
    seedStore(from);

    const result = await migrateAppState(from, to);

    expect(result).toEqual({
      from,
      to,
      files: 4,
      bytes:
        'MANIFEST-000001\n'.length +
        ''.length +
        'a record'.length +
        'nested payload'.length,
    });
    expect(existsSync(from)).toBe(false);
    // 🔴 The bookkeeping matters as much as the data: a store missing CURRENT or its MANIFEST is
    // corrupt, not partial.
    expect(readFileSync(join(to, 'CURRENT'), 'utf8')).toBe('MANIFEST-000001\n');
    expect(readFileSync(join(to, 'LOCK'), 'utf8')).toBe('');
    expect(readFileSync(join(to, '000003.log'), 'utf8')).toBe('a record');
    expect(readFileSync(join(to, 'nested', 'deep.ldb'), 'utf8')).toBe(
      'nested payload',
    );
  });

  /**
   * 🔴 Merging two store directories produces a store that opens and is wrong, which is worse than
   * one that refuses to open. So a non-empty destination is refused rather than merged.
   */
  it('refuses a destination that already holds files', async () => {
    const from = join(base, 'old');
    const to = join(base, 'new');
    seedStore(from);
    mkdirSync(to, { recursive: true });
    writeFileSync(join(to, 'CURRENT'), 'someone else');

    await expect(migrateAppState(from, to)).rejects.toThrow(WorkspaceError);
    await expect(migrateAppState(from, to)).rejects.toThrow(/already contains/);
    expect(existsSync(join(from, 'CURRENT'))).toBe(true);
    expect(readFileSync(join(to, 'CURRENT'), 'utf8')).toBe('someone else');
  });

  it('accepts an empty destination directory', async () => {
    const from = join(base, 'old');
    const to = join(base, 'new');
    seedStore(from);
    mkdirSync(to, { recursive: true });
    await expect(migrateAppState(from, to)).resolves.toMatchObject({
      files: 4,
    });
  });

  it('says so when there is nothing to migrate', async () => {
    await expect(
      migrateAppState(join(base, 'absent'), join(base, 'new')),
    ).rejects.toThrow(/Nothing to migrate/);
    expect(existsSync(join(base, 'new'))).toBe(false);
  });
});
