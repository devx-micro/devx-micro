import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WorkspaceError } from './marker';
import { migrateAppState } from './migrate';

let base: string;
let cwd: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'project-marker-migrate-'));
  // 🔴 Tests that hand a relative path to the function must run in a throwaway cwd: if the guard
  // were ever removed, the failing run would otherwise move the repository checkout itself.
  cwd = process.cwd();
  mkdirSync(join(base, 'cwd'));
  process.chdir(join(base, 'cwd'));
});
afterEach(() => {
  process.chdir(cwd);
  chmodSync(base, 0o755);
  if (existsSync(join(base, 'ro'))) chmodSync(join(base, 'ro'), 0o755);
  rmSync(base, { recursive: true, force: true });
});

/** A stand-in for an embedded database directory: data AND the bookkeeping beside it. */
const seedStore = (path: string) => {
  mkdirSync(join(path, 'nested'), { recursive: true });
  writeFileSync(join(path, 'CURRENT'), 'MANIFEST-000001\n');
  writeFileSync(join(path, 'LOCK'), '');
  writeFileSync(join(path, 'nested', 'deep.ldb'), 'nested payload', {
    mode: 0o600,
  });
};

const refusal = async (from: string, to: string): Promise<string> => {
  const error = await migrateAppState(from, to).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(WorkspaceError);
  return (error as WorkspaceError).message;
};

describe('migrating app state', () => {
  it('moves the directory whole, bookkeeping, nesting and modes included', async () => {
    const from = join(base, 'old');
    const to = join(base, 'new');
    seedStore(from);

    expect(await migrateAppState(from, to)).toEqual({ from, to });

    expect(existsSync(from)).toBe(false);
    expect(readFileSync(join(to, 'CURRENT'), 'utf8')).toBe('MANIFEST-000001\n');
    expect(existsSync(join(to, 'LOCK'))).toBe(true);
    expect(readFileSync(join(to, 'nested', 'deep.ldb'), 'utf8')).toBe(
      'nested payload',
    );
    expect(statSync(join(to, 'nested', 'deep.ldb')).mode & 0o777).toBe(0o600);
  });

  it('moves a directory that holds links as they are, without reading through them', async () => {
    const from = join(base, 'old');
    seedStore(from);
    symlinkSync('CURRENT', join(from, 'link'));
    const to = join(base, 'new');

    await migrateAppState(from, to);

    expect(lstatSync(join(to, 'link')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(to, 'link'))).toBe('CURRENT');
  });

  it('creates missing parents', async () => {
    const from = join(base, 'old');
    seedStore(from);
    const to = join(base, 'a', 'b', 'new');

    await migrateAppState(from, to);

    expect(readFileSync(join(to, 'CURRENT'), 'utf8')).toBe('MANIFEST-000001\n');
  });

  it('moves into an existing empty directory', async () => {
    const from = join(base, 'old');
    const to = join(base, 'new');
    seedStore(from);
    mkdirSync(to);

    await migrateAppState(from, to);

    expect(existsSync(join(to, 'CURRENT'))).toBe(true);
    expect(existsSync(from)).toBe(false);
  });

  it('accepts a trailing slash on either path', async () => {
    const from = join(base, 'old');
    seedStore(from);

    await migrateAppState(`${from}/`, `${join(base, 'new')}/`);

    expect(existsSync(join(base, 'new', 'CURRENT'))).toBe(true);
  });
});

describe('what is refused, with nothing changed', () => {
  it('a ".." segment in either path, which would defeat the same-directory check', async () => {
    const from = join(base, 'src');
    seedStore(from);

    // Nothing at `nx` exists, so a textual reading and the kernel's disagree.
    expect(await refusal(from, `${base}/nx/../src`)).toMatch(/"\.\." segment/);
    expect(await refusal(from, `${from}/n/../m/k`)).toMatch(/"\.\." segment/);
    expect(await refusal(`${base}/x/../src`, join(base, 'new'))).toMatch(
      /"\.\." segment/,
    );

    expect(existsSync(join(base, 'nx'))).toBe(false);
    expect(existsSync(join(from, 'm'))).toBe(false);
    expect(readFileSync(join(from, 'CURRENT'), 'utf8')).toBe(
      'MANIFEST-000001\n',
    );
  });

  it.each([
    ['empty', ''],
    ['the current directory', '.'],
    ['the parent directory', '..'],
    ['a relative path', 'old'],
    ['a Windows-style path on POSIX', String.raw`C:\foo\bar`],
  ])('a %s as the source or the destination', async (_name, bad) => {
    // Real files in the throwaway cwd, so a wrongly accepted path would visibly lose them.
    writeFileSync(join(base, 'cwd', 'precious'), 'keep');
    mkdirSync(join(base, 'cwd', 'old'));
    const elsewhere = join(base, 'elsewhere');
    seedStore(elsewhere);

    expect(await refusal(bad, join(base, 'out'))).toMatch(/absolute/);
    expect(await refusal(elsewhere, bad)).toMatch(/absolute/);

    expect(readFileSync(join(base, 'cwd', 'precious'), 'utf8')).toBe('keep');
    expect(existsSync(join(base, 'cwd', 'old'))).toBe(true);
    expect(existsSync(join(elsewhere, 'CURRENT'))).toBe(true);
    expect(existsSync(join(base, 'out'))).toBe(false);
  });

  it('a source that does not exist', async () => {
    expect(await refusal(join(base, 'nope'), join(base, 'new'))).toMatch(
      /does not exist.*Nothing was changed/,
    );
    expect(existsSync(join(base, 'new'))).toBe(false);
  });

  it('a source that is a file', async () => {
    writeFileSync(join(base, 'file'), 'x');
    expect(await refusal(join(base, 'file'), join(base, 'new'))).toMatch(
      /not a directory/,
    );
    expect(readFileSync(join(base, 'file'), 'utf8')).toBe('x');
  });

  it('a source that is a symbolic link', async () => {
    seedStore(join(base, 'real'));
    symlinkSync(join(base, 'real'), join(base, 'link'));
    expect(await refusal(join(base, 'link'), join(base, 'new'))).toMatch(
      /symbolic link/,
    );
    expect(existsSync(join(base, 'real', 'CURRENT'))).toBe(true);
    expect(lstatSync(join(base, 'link')).isSymbolicLink()).toBe(true);
  });

  it('the same directory, under another spelling or through a link', async () => {
    const from = join(base, 'old');
    seedStore(from);
    symlinkSync(from, join(base, 'alias'));

    expect(await refusal(from, from)).toMatch(/same directory/);
    // A link is never replaced, so a link to the source is refused by the kernel, not renamed over.
    expect(await refusal(from, join(base, 'alias'))).toMatch(/not a directory/);
    expect(lstatSync(join(base, 'alias')).isSymbolicLink()).toBe(true);
    expect(existsSync(join(from, 'CURRENT'))).toBe(true);
  });

  it('a destination inside the source, creating nothing inside it', async () => {
    const from = join(base, 'old');
    seedStore(from);

    const before = statSync(from).mtimeMs;
    expect(await refusal(from, join(from, 'sub', 'new'))).toMatch(
      /the source or inside it/,
    );
    expect(await refusal(from, `${from}/`)).toMatch(/same directory/);
    // Other spellings of "inside": duplicate slashes and `.` segments fold away before the compare.
    for (const spelled of [
      `${base}//old/x/y`,
      `${base}/./old/x/y`,
      `${from}/x/./y`,
    ]) {
      expect(await refusal(from, spelled)).toMatch(/the source or inside it/);
    }
    expect(await refusal(`${base}/./old`, join(from, 'x'))).toMatch(
      /the source or inside it/,
    );
    // A prefix sibling is not inside.
    expect(existsSync(`${from}2`)).toBe(false);
    // Refused before any mkdir, so the source is not even touched.
    expect(statSync(from).mtimeMs).toBe(before);

    expect(existsSync(join(from, 'sub'))).toBe(false);
    expect(readFileSync(join(from, 'CURRENT'), 'utf8')).toBe(
      'MANIFEST-000001\n',
    );
  });

  it('a destination that already holds files, leaving both sides as they were', async () => {
    const from = join(base, 'old');
    const to = join(base, 'new');
    seedStore(from);
    mkdirSync(to);
    writeFileSync(join(to, 'theirs'), 'mine to keep');

    expect(await refusal(from, to)).toMatch(/already holds files/);

    expect(readFileSync(join(to, 'theirs'), 'utf8')).toBe('mine to keep');
    expect(existsSync(join(to, 'CURRENT'))).toBe(false);
    expect(existsSync(join(from, 'CURRENT'))).toBe(true);
  });

  it('a destination that is a file', async () => {
    const from = join(base, 'old');
    seedStore(from);
    writeFileSync(join(base, 'new'), 'a file');

    await refusal(from, join(base, 'new'));

    expect(readFileSync(join(base, 'new'), 'utf8')).toBe('a file');
    expect(existsSync(join(from, 'CURRENT'))).toBe(true);
  });

  it('removes the parents it created when the move then fails', async () => {
    const from = join(base, 'old');
    const to = join(base, 'a', 'b', 'new');
    seedStore(from);
    mkdirSync(join(base, 'a', 'b', 'new'), { recursive: true });
    writeFileSync(join(base, 'a', 'b', 'new', 'theirs'), 'x');
    // `a/b` existed already, so nothing may be removed.
    expect(await refusal(from, to)).toMatch(
      /already holds files.*nothing was created/,
    );
    expect(existsSync(join(base, 'a', 'b', 'new', 'theirs'))).toBe(true);

    rmSync(join(base, 'a'), { recursive: true });
    const deep = join(base, 'c', 'd', 'new');
    mkdirSync(join(base, 'c'));
    writeFileSync(join(base, 'c', 'file'), 'x');
    // A parent that is a file: creation fails, the source is untouched.
    expect(await refusal(from, join(base, 'c', 'file', 'new'))).toMatch(
      /Creating the parent of .* failed/,
    );
    expect(existsSync(deep)).toBe(false);
    expect(existsSync(join(from, 'CURRENT'))).toBe(true);
  });

  // Reported as skipped, not silently passed, where this machine has no second filesystem.
  const other = '/dev/shm';
  const second =
    existsSync(other) && statSync(other).dev !== statSync(tmpdir()).dev;
  it.skipIf(!second)('a destination on another filesystem', async () => {
    const from = join(base, 'old');
    seedStore(from);
    const target = mkdtempSync(join(other, 'project-marker-xdev-'));
    try {
      expect(await refusal(from, join(target, 'new'))).toMatch(
        /different filesystems/,
      );
      expect(existsSync(join(from, 'CURRENT'))).toBe(true);
      expect(existsSync(join(target, 'new'))).toBe(false);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

describe('cleanup after a failed move', () => {
  // A source in a read-only parent cannot be renamed away (EACCES), which fails the move after the
  // destination's parents were created. Root ignores directory permissions, so skip there.
  const asRoot = process.getuid?.() === 0;

  it.skipIf(asRoot)(
    'never removes what a concurrent migration put into the parents it created',
    async () => {
      const locked = join(base, 'ro');
      mkdirSync(join(locked, 'src'), { recursive: true });
      chmodSync(locked, 0o555);
      const ok = join(base, 'b');
      seedStore(ok);
      const parent = join(base, 'new');

      for (let round = 0; round < 40; round++) {
        rmSync(parent, { recursive: true, force: true });
        const [failed, moved] = await Promise.allSettled([
          migrateAppState(join(locked, 'src'), join(parent, 'a')),
          (async () => {
            const target = join(parent, 'b');
            const result = await migrateAppState(ok, target);
            return result.to;
          })(),
        ]);
        expect(failed.status).toBe('rejected');
        if (moved.status === 'fulfilled') {
          // B's data must survive A's cleanup, whatever the interleaving.
          expect(readFileSync(join(parent, 'b', 'CURRENT'), 'utf8')).toBe(
            'MANIFEST-000001\n',
          );
          // Put it back for the next round.
          rmSync(ok, { recursive: true, force: true });
          renameSync(join(parent, 'b'), ok);
        } else {
          // B lost a race to A's cleanup of the shared parent: it must fail whole, not half-move.
          expect(existsSync(join(ok, 'CURRENT'))).toBe(true);
        }
      }
    },
  );

  it.skipIf(asRoot)(
    'removes exactly the parents it created, and says so',
    async () => {
      const locked = join(base, 'ro');
      mkdirSync(join(locked, 'src'), { recursive: true });
      chmodSync(locked, 0o555);
      mkdirSync(join(base, 'kept'));

      const message = await refusal(
        join(locked, 'src'),
        join(base, 'kept', 'x', 'y', 'new'),
      );

      expect(message).toMatch(/was removed/);
      expect(existsSync(join(base, 'kept'))).toBe(true);
      expect(existsSync(join(base, 'kept', 'x'))).toBe(false);
    },
  );
});
