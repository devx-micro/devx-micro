import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
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

describe('migrating an empty store', () => {
  it('moves it, and reports nothing copied', async () => {
    const from = join(base, 'old');
    const to = join(base, 'new');
    mkdirSync(from);
    await expect(migrateAppState(from, to)).resolves.toEqual({
      from,
      to,
      files: 0,
      bytes: 0,
    });
    expect(existsSync(from)).toBe(false);
    expect(readdirSync(to)).toEqual([]);
  });
});

/**
 * 🔴 Symbolic links are refused, before anything is copied.
 *
 * A link cannot be verified by reading through it: a relative link copied as an absolute link
 * back into the source reads identically until the source is removed, and then dangles. That is a
 * migration that verifies, reports success, and loses the store's pointer file. Refusing is the
 * only answer that cannot be wrong; a person can resolve the links and run it again.
 */
describe('a source that is not plain files and directories is refused', () => {
  const sourceWithLink = (target: string) => {
    const from = join(base, 'old');
    mkdirSync(join(from, 'data'), { recursive: true });
    writeFileSync(join(from, 'MANIFEST-1'), 'manifest bytes');
    writeFileSync(join(from, 'data', 'f'), 'x');
    symlinkSync(target, join(from, 'CURRENT'));
    return from;
  };

  it.each([
    ['a relative link to a file', 'MANIFEST-1'],
    ['a link to a directory', 'data'],
    ['a dangling link', 'missing'],
  ])('refuses %s, and touches neither side', async (_label, target) => {
    const from = sourceWithLink(target);
    const to = join(base, 'new');

    const failure = await migrateAppState(from, to).catch((error) => error);

    expect(failure).toBeInstanceOf(WorkspaceError);
    expect((failure as Error).message).toMatch(/CURRENT is a symbolic link/);
    expect(readlinkSync(join(from, 'CURRENT'))).toBe(target);
    expect(readFileSync(join(from, 'MANIFEST-1'), 'utf8')).toBe(
      'manifest bytes',
    );
    expect(existsSync(to)).toBe(false);
  });

  it('refuses a link nested below the top level', async () => {
    const from = join(base, 'old');
    mkdirSync(join(from, 'a', 'b'), { recursive: true });
    symlinkSync('..', join(from, 'a', 'b', 'up'));
    await expect(migrateAppState(from, join(base, 'new'))).rejects.toThrow(
      /a\/b\/up is a symbolic link/,
    );
  });

  it('refuses a source that is itself a symbolic link', async () => {
    const real = join(base, 'real');
    mkdirSync(real);
    writeFileSync(join(real, 'f'), 'x');
    const from = join(base, 'old');
    symlinkSync(real, from);
    await expect(migrateAppState(from, join(base, 'new'))).rejects.toThrow(
      WorkspaceError,
    );
    expect(readFileSync(join(real, 'f'), 'utf8')).toBe('x');
    expect(existsSync(join(base, 'new'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a special file, such as a named pipe',
    async () => {
      const from = join(base, 'old');
      mkdirSync(from);
      execFileSync('mkfifo', [join(from, 'pipe')]);
      await expect(migrateAppState(from, join(base, 'new'))).rejects.toThrow(
        /pipe is not a regular file or directory/,
      );
      expect(existsSync(join(base, 'new'))).toBe(false);
    },
  );

  it('refuses a source that is a file, without creating the destination', async () => {
    const from = join(base, 'a-file');
    writeFileSync(from, 'x');
    const to = join(base, 'new');
    await expect(migrateAppState(from, to)).rejects.toThrow(
      /is not a directory/,
    );
    expect(existsSync(to)).toBe(false);
    expect(readFileSync(from, 'utf8')).toBe('x');
  });
});

describe('a destination that cannot hold the copy is refused up front', () => {
  it('refuses a destination that is a file', async () => {
    const from = join(base, 'old');
    mkdirSync(from);
    writeFileSync(join(from, 'f'), 'x');
    const to = join(base, 'a-file');
    writeFileSync(to, 'y');
    const failure = await migrateAppState(from, to).catch((error) => error);
    expect(failure).toBeInstanceOf(WorkspaceError);
    expect((failure as Error).message).toMatch(/is not a directory/);
    expect(readFileSync(to, 'utf8')).toBe('y');
    expect(readFileSync(join(from, 'f'), 'utf8')).toBe('x');
  });

  /**
   * 🔴 Copying a directory into itself (or onto itself) mutates the source before any copy is
   * checked: the destination directory is created inside it. So overlap is refused before anything
   * is created.
   */
  it('refuses a destination inside the source, and leaves the source as it was', async () => {
    const from = join(base, 'old');
    mkdirSync(from);
    writeFileSync(join(from, 'f'), 'x');
    const failure = await migrateAppState(from, join(from, 'child')).catch(
      (error) => error,
    );
    expect(failure).toBeInstanceOf(WorkspaceError);
    expect((failure as Error).message).toMatch(/overlap/);
    expect(readdirSync(from)).toEqual(['f']);
  });

  it('refuses a source inside the destination', async () => {
    const outer = join(base, 'outer');
    const from = join(outer, 'old');
    mkdirSync(from, { recursive: true });
    writeFileSync(join(from, 'f'), 'x');
    await expect(migrateAppState(from, outer)).rejects.toThrow(/overlap/);
    expect(readdirSync(from)).toEqual(['f']);
  });

  it('refuses the same directory as both source and destination', async () => {
    const from = join(base, 'old');
    mkdirSync(from);
    await expect(migrateAppState(from, from)).rejects.toThrow(/overlap/);
    expect(existsSync(from)).toBe(true);
  });

  it('sees overlap through a symbolic link in the destination’s path', async () => {
    const from = join(base, 'old');
    mkdirSync(from);
    writeFileSync(join(from, 'f'), 'x');
    const alias = join(base, 'alias');
    symlinkSync(from, alias);
    await expect(migrateAppState(from, join(alias, 'child'))).rejects.toThrow(
      /overlap/,
    );
    expect(readdirSync(from)).toEqual(['f']);
  });

  it('does not mistake a sibling with a shared prefix for overlap', async () => {
    const from = join(base, 'old');
    mkdirSync(from);
    writeFileSync(join(from, 'f'), 'x');
    await expect(
      migrateAppState(from, join(base, 'old-copy')),
    ).resolves.toMatchObject({ files: 1 });
  });
});

describe('paths that cannot be inspected or created', () => {
  it('treats a source beneath a file as absent', async () => {
    writeFileSync(join(base, 'a-file'), 'x');
    await expect(
      migrateAppState(join(base, 'a-file', 'old'), join(base, 'new')),
    ).rejects.toThrow(/Nothing to migrate/);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports a source it may not inspect as a WorkspaceError',
    async () => {
      const locked = join(base, 'locked');
      mkdirSync(join(locked, 'old'), { recursive: true });
      chmodSync(locked, 0o000);
      try {
        await expect(
          migrateAppState(join(locked, 'old'), join(base, 'new')),
        ).rejects.toThrow(/Cannot inspect .*EACCES/);
      } finally {
        chmodSync(locked, 0o700);
      }
      expect(existsSync(join(base, 'new'))).toBe(false);
    },
  );

  it('reports a destination that cannot be created as a WorkspaceError, and keeps the source', async () => {
    const from = join(base, 'old');
    mkdirSync(from);
    writeFileSync(join(from, 'f'), 'x');
    writeFileSync(join(base, 'a-file'), 'y');

    const failure = await migrateAppState(
      from,
      join(base, 'a-file', 'new'),
    ).catch((error) => error);

    expect(failure).toBeInstanceOf(WorkspaceError);
    expect((failure as Error).message).toMatch(
      /Migrating .* failed: .*ENOTDIR/,
    );
    expect((failure as Error).message).toMatch(/left untouched/);
    expect(readFileSync(join(from, 'f'), 'utf8')).toBe('x');
    expect(readFileSync(join(base, 'a-file'), 'utf8')).toBe('y');
  });
});
