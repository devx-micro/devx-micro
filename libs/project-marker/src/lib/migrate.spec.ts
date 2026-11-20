import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
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
import { join, relative } from 'node:path';

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

  /**
   * 🔴 An empty path is not "the current directory": without the refusal, `resolveOnce` would
   * join it to the cwd and migrate from, or into, the caller's own working tree. Seeding the real
   * source proves the refusal happens before anything is read or copied.
   */
  it('refuses an empty source path, changing nothing', async () => {
    const from = join(base, 'old');
    seedStore(from);

    const failure = await migrateAppState('', join(base, 'new')).catch(
      (error) => error,
    );

    expect(failure).toBeInstanceOf(WorkspaceError);
    expect((failure as Error).message).toMatch(
      /the source path \(from\) is empty/,
    );
    expect((failure as Error).message).toMatch(/Nothing was changed/);
    expect(existsSync(from)).toBe(true);
    expect(existsSync(join(base, 'new'))).toBe(false);
  });

  it('refuses an empty destination path, changing nothing', async () => {
    const from = join(base, 'old');
    seedStore(from);

    const failure = await migrateAppState(from, '').catch((error) => error);

    expect(failure).toBeInstanceOf(WorkspaceError);
    expect((failure as Error).message).toMatch(
      /the destination path \(to\) is empty/,
    );
    expect((failure as Error).message).toMatch(/Nothing was changed/);
    expect(existsSync(from)).toBe(true);
    expect(readdirSync(base)).toEqual(['old']);
  });

  /**
   * A name made of whitespace is a legal file-system name, not an empty path: the refusal above
   * applies to the empty STRING, and this pins that a whitespace-only name still migrates.
   */
  it('migrates a directory whose name is a single space', async () => {
    const from = join(base, ' ');
    const to = join(base, 'moved');
    seedStore(from);

    await expect(migrateAppState(from, to)).resolves.toMatchObject({
      files: 4,
    });
    expect(existsSync(from)).toBe(false);
    expect(readFileSync(join(to, 'nested', 'deep.ldb'), 'utf8')).toBe(
      'nested payload',
    );
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

  it('refuses a destination beneath a file up front, without claiming it created anything', async () => {
    const from = join(base, 'old');
    mkdirSync(from);
    writeFileSync(join(from, 'f'), 'x');
    writeFileSync(join(base, 'a-file'), 'y');

    const failure = await migrateAppState(
      from,
      join(base, 'a-file', 'new'),
    ).catch((error) => error);

    expect(failure).toBeInstanceOf(WorkspaceError);
    expect((failure as Error).message).toMatch(/a-file is not a directory/);
    expect((failure as Error).message).not.toMatch(/created/);
    expect(readFileSync(join(from, 'f'), 'utf8')).toBe('x');
    expect(readFileSync(join(base, 'a-file'), 'utf8')).toBe('y');
  });

  const lockedWhile = async (directory: string, run: () => Promise<void>) => {
    chmodSync(directory, 0o000);
    try {
      await run();
    } finally {
      chmodSync(directory, 0o700);
    }
  };

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports an unreadable directory inside the source as a WorkspaceError, changing nothing',
    async () => {
      const from = join(base, 'old');
      mkdirSync(join(from, 'locked'), { recursive: true });
      writeFileSync(join(from, 'locked', 'x'), '1');
      const to = join(base, 'new');
      await lockedWhile(join(from, 'locked'), async () => {
        const failure = await migrateAppState(from, to).catch((error) => error);
        expect(failure).toBeInstanceOf(WorkspaceError);
        expect((failure as Error).message).toMatch(
          /Cannot inspect .*old\/locked.*EACCES.*Nothing was changed/,
        );
      });
      expect(existsSync(to)).toBe(false);
      expect(readFileSync(join(from, 'locked', 'x'), 'utf8')).toBe('1');
    },
  );

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports an unreadable directory inside an empty destination as a WorkspaceError, changing nothing',
    async () => {
      const from = join(base, 'old');
      mkdirSync(from);
      writeFileSync(join(from, 'f'), '1');
      const to = join(base, 'new');
      mkdirSync(join(to, 'locked'), { recursive: true });
      await lockedWhile(join(to, 'locked'), async () => {
        const failure = await migrateAppState(from, to).catch((error) => error);
        expect(failure).toBeInstanceOf(WorkspaceError);
        expect((failure as Error).message).toMatch(
          /Cannot inspect .*new\/locked.*EACCES.*Nothing was changed/,
        );
      });
      expect(readdirSync(to)).toEqual(['locked']);
      expect(readFileSync(join(from, 'f'), 'utf8')).toBe('1');
    },
  );
});

/**
 * 🔴 One destination, one meaning. `..` after a symbolic link means the link's TARGET's parent to
 * the operating system, but the link's own parent to anything that normalises the path as text. If
 * the overlap check, `mkdir`, `cp` and the cleanup each read `to` their own way, the copy can
 * land inside the source, or in a directory the caller never named. So `to` is resolved once, as
 * the operating system resolves it, and that one path is used for everything.
 */
describe('the destination is resolved once, as the operating system resolves it', () => {
  const seed = () => {
    const from = join(base, 'src');
    mkdirSync(join(from, 'sub'), { recursive: true });
    writeFileSync(join(from, 'f'), 'data');
    writeFileSync(join(from, 'sub', 'g'), 'more');
    return from;
  };
  const tree = (root: string): string[] => {
    const out: string[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        out.push(relative(root, path));
        if (entry.isDirectory()) walk(path);
      }
    };
    walk(root);
    return out.sort();
  };

  it('refuses <link>/../x when, read that way, x lands inside the source', async () => {
    const from = seed();
    symlinkSync(join(from, 'sub'), join(base, 'lnk'));
    const before = tree(from);

    const failure = await migrateAppState(from, `${base}/lnk/../newdir`).catch(
      (error) => error,
    );

    expect(failure).toBeInstanceOf(WorkspaceError);
    expect((failure as Error).message).toMatch(/overlap/);
    expect(tree(from)).toEqual(before);
    expect(existsSync(join(base, 'newdir'))).toBe(false);
  });

  it('leaves a directory with the text-normalised name alone', async () => {
    const from = seed();
    symlinkSync(join(from, 'sub'), join(base, 'lnk'));
    mkdirSync(join(base, 'newdir'));

    await expect(
      migrateAppState(from, `${base}/lnk/../newdir`),
    ).rejects.toThrow(/overlap/);

    expect(readdirSync(join(base, 'newdir'))).toEqual([]);
  });

  it('migrates to where the operating system says <link>/../x is', async () => {
    const from = seed();
    mkdirSync(join(base, 'x', 'y'), { recursive: true });
    symlinkSync(join(base, 'x', 'y'), join(base, 'ly'));
    mkdirSync(join(base, 'out'));

    await expect(
      migrateAppState(from, `${base}/ly/../out`),
    ).resolves.toMatchObject({ files: 2 });

    expect(readFileSync(join(base, 'x', 'out', 'f'), 'utf8')).toBe('data');
    expect(readdirSync(join(base, 'out'))).toEqual([]);
    expect(existsSync(from)).toBe(false);
  });

  it('refuses .. after a directory that does not exist, since it has no single meaning', async () => {
    const from = seed();
    await expect(
      migrateAppState(from, `${base}/missing/../new`),
    ).rejects.toThrow(/does not exist/);
    expect(existsSync(join(base, 'missing'))).toBe(false);
    expect(existsSync(join(base, 'new'))).toBe(false);
  });

  it('resolves a relative destination against the current directory, the same way', async () => {
    const from = seed();
    const previous = process.cwd();
    process.chdir(from);
    try {
      await expect(migrateAppState(from, './child')).rejects.toThrow(/overlap/);
    } finally {
      process.chdir(previous);
    }
    expect(existsSync(join(from, 'child'))).toBe(false);
  });

  /**
   * 🔴 Whether the destination existed is decided without following a link. A dangling link reads
   * as absent to `stat`, and a cleanup that believed it had created it would delete the caller's
   * link.
   */
  it.each([
    ['into the source', (from: string) => join(from, 'newsub')],
    ['elsewhere', () => join(base, 'elsewhere', 'x')],
  ])(
    'refuses a destination that is a dangling link %s, and keeps the link',
    async (_label, target) => {
      const from = seed();
      const to = join(base, 'dang');
      symlinkSync(target(from), to);

      const failure = await migrateAppState(from, to).catch((error) => error);

      expect(failure).toBeInstanceOf(WorkspaceError);
      expect((failure as Error).message).toMatch(/symbolic link/);
      expect(lstatSync(to).isSymbolicLink()).toBe(true);
      expect(readlinkSync(to)).toBe(target(from));
      expect(existsSync(join(from, 'newsub'))).toBe(false);
    },
  );

  it('refuses a destination reached through a dangling link, and keeps the link', async () => {
    const from = seed();
    symlinkSync(join(from, 'zz'), join(base, 'dc'));

    const failure = await migrateAppState(from, join(base, 'dc', 'new')).catch(
      (error) => error,
    );

    expect(failure).toBeInstanceOf(WorkspaceError);
    expect((failure as Error).message).toMatch(
      /dc is a symbolic link to nothing/,
    );
    expect(lstatSync(join(base, 'dc')).isSymbolicLink()).toBe(true);
    expect(existsSync(join(from, 'zz'))).toBe(false);
  });

  it('refuses a destination that is a link to an empty directory, before copying', async () => {
    const from = seed();
    mkdirSync(join(base, 'real'));
    symlinkSync(join(base, 'real'), join(base, 'tl'));

    const failure = await migrateAppState(from, join(base, 'tl')).catch(
      (error) => error,
    );

    expect(failure).toBeInstanceOf(WorkspaceError);
    expect((failure as Error).message).toMatch(/tl: it is a symbolic link/);
    expect((failure as Error).message).toMatch(/Nothing was changed/);
    expect(readdirSync(join(base, 'real'))).toEqual([]);
    expect(lstatSync(join(base, 'tl')).isSymbolicLink()).toBe(true);
  });

  it('follows a link in the source path to the real directory', async () => {
    const from = seed();
    symlinkSync(base, `${base}-alias`);
    try {
      await expect(
        migrateAppState(`${base}-alias/src`, join(base, 'moved')),
      ).resolves.toMatchObject({ files: 2 });
    } finally {
      rmSync(`${base}-alias`);
    }
    expect(existsSync(from)).toBe(false);
    expect(readFileSync(join(base, 'moved', 'sub', 'g'), 'utf8')).toBe('more');
  });
});

describe('more shapes of path, resolved the same way', () => {
  const seed = () => {
    const from = join(base, 'src');
    mkdirSync(from, { recursive: true });
    writeFileSync(join(from, 'f'), 'data');
    return from;
  };

  it('refuses a destination reached through a link to a file', async () => {
    const from = seed();
    writeFileSync(join(base, 'plain'), 'x');
    symlinkSync(join(base, 'plain'), join(base, 'flink'));
    await expect(
      migrateAppState(from, join(base, 'flink', 'new')),
    ).rejects.toThrow(/flink is not a directory.*Nothing was changed/);
    expect(readFileSync(join(base, 'plain'), 'utf8')).toBe('x');
  });

  it('accepts a source path that ends in "."', async () => {
    const from = seed();
    await expect(
      migrateAppState(`${from}/.`, join(base, 'moved')),
    ).resolves.toMatchObject({ files: 1 });
    expect(existsSync(from)).toBe(false);
  });

  it('ignores "." inside the part of the destination that does not exist yet', async () => {
    const from = seed();
    await expect(
      migrateAppState(from, `${base}/n1/./n2`),
    ).resolves.toMatchObject({ files: 1 });
    expect(readFileSync(join(base, 'n1', 'n2', 'f'), 'utf8')).toBe('data');
  });

  /**
   * 🔴 On POSIX a backslash is an ordinary character in a file name, not a path separator.
   * Splitting on it would treat `a\b` as two components and report a source that does not exist
   * (or create a destination with the wrong name).
   */
  it.skipIf(process.platform === 'win32')(
    'keeps a backslash in a source name whole',
    async () => {
      const from = join(base, 'a\\b');
      seedStore(from);
      await expect(
        migrateAppState(from, join(base, 'moved')),
      ).resolves.toMatchObject({ files: 4 });
      expect(existsSync(from)).toBe(false);
      expect(
        readFileSync(join(base, 'moved', 'nested', 'deep.ldb'), 'utf8'),
      ).toBe('nested payload');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'creates a destination whose name holds a backslash',
    async () => {
      const from = seed();
      const to = join(base, 'new\\dir');
      await expect(migrateAppState(from, to)).resolves.toMatchObject({
        files: 1,
      });
      expect(readFileSync(join(to, 'f'), 'utf8')).toBe('data');
      expect(existsSync(from)).toBe(false);
    },
  );

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports a link it may not resolve as a WorkspaceError, changing nothing',
    async () => {
      const from = seed();
      mkdirSync(join(base, 'locked', 'sub'), { recursive: true });
      symlinkSync(join(base, 'locked', 'sub'), join(base, 'ln'));
      chmodSync(join(base, 'locked'), 0o000);
      try {
        await expect(
          migrateAppState(from, join(base, 'ln', 'new')),
        ).rejects.toThrow(/Cannot inspect .*EACCES.*Nothing was changed/);
      } finally {
        chmodSync(join(base, 'locked'), 0o700);
      }
      expect(readdirSync(join(base, 'locked', 'sub'))).toEqual([]);
    },
  );

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'says nothing was created when the destination cannot be created',
    async () => {
      const from = seed();
      mkdirSync(join(base, 'ro'));
      chmodSync(join(base, 'ro'), 0o500);
      let failure: unknown;
      try {
        failure = await migrateAppState(
          from,
          join(base, 'ro', 'p1', 'new'),
        ).catch((error) => error);
      } finally {
        chmodSync(join(base, 'ro'), 0o700);
      }
      expect(failure).toBeInstanceOf(WorkspaceError);
      expect((failure as Error).message).toMatch(
        /Creating .* failed \(EACCES\).*left untouched; nothing was created\.$/s,
      );
      expect(readdirSync(join(base, 'ro'))).toEqual([]);
      expect(readFileSync(join(from, 'f'), 'utf8')).toBe('data');
    },
  );
});

/**
 * The overlap check compares paths as text, so it can only see a case-only difference on a
 * case-SENSITIVE filesystem; on a case-INSENSITIVE one, `Store` and `store` are the same
 * directory and the overlap is real. Probe the filesystem once, and run the test only where it
 * can actually fire — on a case-sensitive one the two names name different directories, and the
 * migration is legitimately allowed.
 */
const fsCaseInsensitive = (() => {
  const probe = mkdtempSync(join(tmpdir(), 'project-marker-case-'));
  try {
    mkdirSync(join(probe, 'Probe'));
    return existsSync(join(probe, 'probe'));
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

describe('overlap that only a case-insensitive filesystem can see', () => {
  it.skipIf(!fsCaseInsensitive)(
    'refuses a destination that differs from the source only in case',
    async () => {
      const from = join(base, 'Store');
      seedStore(from);

      const failure = await migrateAppState(
        from,
        join(base, 'store', 'moved'),
      ).catch((error) => error);

      expect(failure).toBeInstanceOf(WorkspaceError);
      expect((failure as Error).message).toMatch(/overlap/);
      expect((failure as Error).message).toMatch(/Nothing was changed/);
      // The source is untouched, and no directory was created inside it under the other spelling.
      expect(existsSync(from)).toBe(true);
      expect(readFileSync(join(from, 'nested', 'deep.ldb'), 'utf8')).toBe(
        'nested payload',
      );
      expect(existsSync(join(base, 'store', 'moved'))).toBe(false);
    },
  );
});
