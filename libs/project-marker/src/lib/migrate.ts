import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
} from 'node:fs/promises';
import type { Stats } from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';

import { WorkspaceError } from './marker';

/** What {@link migrateAppState} moved. */
export interface MigrationResult {
  /** The source directory, which no longer exists. */
  readonly from: string;
  /** The destination directory. */
  readonly to: string;
  /** How many files were copied and verified. */
  readonly files: number;
  /** Their total size, in bytes. */
  readonly bytes: number;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Every entry under `root` that is not a directory, as sorted relative paths. */
async function filesUnder(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else found.push(relative(root, path));
    }
  };
  await walk(root);
  return found.sort();
}

/**
 * The regular files under `from`, as sorted relative paths, refusing anything else.
 *
 * 🔴 **Symbolic links are refused, not followed and not copied.** A link cannot be verified by
 * reading through it: `fs.cp` rewrites a relative link as an absolute link back into the source,
 * which reads identically until the source is removed and then dangles. A verbatim copy is no
 * better for an absolute link into the source, or a relative one that leaves the tree. Refusing is
 * the one answer that cannot report success and lose data. Other special files (pipes, sockets,
 * devices) are not store contents either, and are refused for the same reason.
 */
async function regularFilesUnder(from: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const name = relative(from, path);
      if (entry.isSymbolicLink()) {
        throw new WorkspaceError(
          `Refusing to migrate ${from}: ${name} is a symbolic link, and a link cannot be verified ` +
            'by reading through it. Replace it with the file or directory it points to, or ' +
            'remove it, and migrate again.',
        );
      }
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) found.push(name);
      else {
        throw new WorkspaceError(
          `Refusing to migrate ${from}: ${name} is not a regular file or directory.`,
        );
      }
    }
  };
  await walk(from);
  return found.sort();
}

const statOrUndefined = async (
  read: (path: string) => Promise<Stats>,
  path: string,
): Promise<Stats | undefined> => {
  try {
    return await read(path);
  } catch (error) {
    // ENOTDIR: a component of the path is a file, so nothing can exist at the path itself.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw new WorkspaceError(`Cannot inspect ${path}: ${messageOf(error)}`);
  }
};

/** `path` with symbolic links resolved, for as much of it as exists. */
async function realPathOfNearest(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    const parent = dirname(path);
    if (parent === path) return path;
    return join(await realPathOfNearest(parent), basename(path));
  }
}

const isWithin = (child: string, parent: string): boolean => {
  const rel = relative(parent, child);
  return (
    rel === '' ||
    (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
};

/**
 * Move one app's on-disk state from one directory to another, for example from an old location
 * into {@link ProjectMarker.appStatePathOf}.
 *
 * 🔴 **Copy, verify, then remove; never move then verify.** A failed verification after a move
 * leaves nothing to fall back to. Embedded databases keep bookkeeping files (lock, log, manifest,
 * "current" pointer) beside their data, and all of them are part of the store, so a migration that
 * copies "the data files" and skips the bookkeeping produces a **corrupt** store rather than a
 * partial one. That is why verification compares the file list and then the bytes of every file,
 * rather than counting files: a truncated or altered copy still has the right name.
 *
 * 🔴 **It refuses a non-empty destination.** Merging two store directories produces a store that
 * opens and is wrong, which is worse than one that refuses to open. An empty or absent destination
 * is accepted.
 *
 * 🔴 **The source must hold only regular files and directories.** A symbolic link anywhere in it,
 * or a source that is itself a link, is refused before anything is copied: a link cannot be
 * verified by reading through it, and a copied link can dangle once the source is removed.
 *
 * **What a failure leaves behind.** Every failure throws {@link WorkspaceError}:
 *
 * - Refused before copying (the source is absent, is not a directory, or holds a link or special
 *   file; the destination is not a directory or holds files; the two overlap): **nothing is
 *   changed**, on either side.
 * - The copy or its verification fails: the source is **untouched**. A destination this call
 *   created is **removed**, so the migration can simply be run again. A destination that existed
 *   (empty) before the call is **left as it is**, and may hold a partial copy; empty it before
 *   retrying. The error says which happened.
 * - Removing the source fails, after a verified copy: the copy at `to` is **complete**, and the
 *   source may be partly removed. The error says so; remove the source by hand.
 *
 * @param from - The directory to move. It must exist and hold only regular files and directories.
 * @param to - Where to move it. It must be absent or an empty directory, and must not overlap
 * `from` (neither inside the other, nor the same directory).
 * @returns What was moved; the source has been removed.
 * @throws {@link WorkspaceError} in each case listed above.
 */
export async function migrateAppState(
  from: string,
  to: string,
): Promise<MigrationResult> {
  const source = await statOrUndefined(lstat, from);
  if (!source) {
    throw new WorkspaceError(`Nothing to migrate: ${from} does not exist.`);
  }
  if (source.isSymbolicLink()) {
    throw new WorkspaceError(
      `Refusing to migrate ${from}: it is a symbolic link. Migrate the directory it points to.`,
    );
  }
  if (!source.isDirectory()) {
    throw new WorkspaceError(
      `Refusing to migrate ${from}: it is not a directory.`,
    );
  }

  // 🔴 Overlap is checked on real paths, before anything is created: copying a directory into
  // itself creates the destination inside the source, mutating it before any copy is checked.
  const realFrom = await realpath(from);
  const realTo = await realPathOfNearest(resolve(to));
  if (isWithin(realTo, realFrom) || isWithin(realFrom, realTo)) {
    throw new WorkspaceError(
      `Refusing to migrate ${from} into ${to}: the two overlap (one is inside the other, or they ` +
        'are the same directory).',
    );
  }

  const destination = await statOrUndefined(stat, to);
  if (destination && !destination.isDirectory()) {
    throw new WorkspaceError(
      `Refusing to migrate into ${to}: it exists and is not a directory.`,
    );
  }
  if (destination) {
    const occupied = await filesUnder(to);
    if (occupied.length > 0) {
      throw new WorkspaceError(
        `Refusing to migrate into ${to}: it already contains ${occupied.length} file(s).\n` +
          'Merging two stores produces one that opens and is wrong. Move or remove the ' +
          'destination first.',
      );
    }
  }

  const files = await regularFilesUnder(from);

  let bytes = 0;
  try {
    await mkdir(to, { recursive: true });
    try {
      await cp(from, to, { recursive: true, verbatimSymlinks: true });
    } catch (error) {
      throw new WorkspaceError(
        `Copying ${from} to ${to} failed: ${messageOf(error)}.`,
      );
    }

    // Verify before removing anything. Bytes, not counts: a truncated copy has the right name.
    // The source is listed again, so anything that appeared in it during the copy is caught too.
    const listed = await regularFilesUnder(from);
    const copied = await filesUnder(to);
    if (
      listed.join('\n') !== files.join('\n') ||
      copied.join('\n') !== files.join('\n')
    ) {
      throw new WorkspaceError(
        `Migration verification failed: ${from} has ${listed.length} file(s), ${to} has ` +
          `${copied.length}.`,
      );
    }
    for (const file of files) {
      const before = await readFile(join(from, file));
      const after = await readFile(join(to, file));
      if (!before.equals(after)) {
        throw new WorkspaceError(
          `Migration verification failed: ${file} differs after copying.`,
        );
      }
      bytes += before.byteLength;
    }
  } catch (error) {
    const cleanup = destination
      ? `${to} existed before this call and has been left as it is; it may hold a partial copy, ` +
        'so empty it before retrying'
      : await rm(to, { recursive: true, force: true }).then(
          () => `${to}, which this call created, was removed`,
          (failure: unknown) =>
            `${to}, which this call created, could not be removed (${messageOf(failure)}); ` +
            'remove it before retrying',
        );
    const reason =
      error instanceof WorkspaceError
        ? error.message
        : `Migrating ${from} to ${to} failed: ${messageOf(error)}.`;
    throw new WorkspaceError(
      `${reason} The source has been left untouched; ${cleanup}.`,
    );
  }

  try {
    await rm(from, { recursive: true, force: true });
  } catch (error) {
    throw new WorkspaceError(
      `The copy at ${to} is complete and verified, but removing ${from} failed: ` +
        `${messageOf(error)}. ${from} may be partly removed; remove the rest by hand.`,
    );
  }
  return { from, to, files: files.length, bytes };
}
