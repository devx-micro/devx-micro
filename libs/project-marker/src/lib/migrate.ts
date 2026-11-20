import { lstat, mkdir, rename, rmdir } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';

import { WorkspaceError } from './marker';

/** What {@link migrateAppState} moved. */
export interface MigrationResult {
  /** The source directory, as given, which no longer exists. */
  readonly from: string;
  /** The destination directory, as given. */
  readonly to: string;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const codeOf = (error: unknown): string =>
  (error as NodeJS.ErrnoException | undefined)?.code ?? 'unknown error';

/** `lstat`, or `undefined` when nothing is there. Any other failure is reported, not hidden. */
async function statOrAbsent(path: string, role: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (codeOf(error) === 'ENOENT' || codeOf(error) === 'ENOTDIR') {
      return undefined;
    }
    throw new WorkspaceError(
      `Cannot inspect the ${role} ${path} (${codeOf(error)}): ${messageOf(error)}. Nothing was changed.`,
    );
  }
}

const requireAbsolute = (path: unknown, role: string): void => {
  if (typeof path !== 'string' || path === '' || !isAbsolute(path)) {
    throw new WorkspaceError(
      `Refusing to migrate: the ${role} path must be a non-empty absolute path, got ` +
        `${JSON.stringify(path) ?? String(path)}. A relative path would be read against the ` +
        'current directory, which is almost never what was meant. Nothing was changed.',
    );
  }
  // 🔴 `a/../b` names `b` only if `a` exists and is not a link; the operating system and a textual
  // reading disagree otherwise, so the same-directory and inside-the-source checks cannot be
  // trusted. Refuse it rather than guess; callers build paths from a root and never need it.
  const separators = process.platform === 'win32' ? /[\\/]+/ : /\/+/;
  if (path.split(separators).includes('..')) {
    throw new WorkspaceError(
      `Refusing to migrate: the ${role} path ${path} contains a ".." segment. Pass a path without ` +
        'one. Nothing was changed.',
    );
  }
};

/** Parent directories of `path` that do not exist yet, shallowest first. */
async function missingParentsOf(path: string): Promise<string[]> {
  const missing: string[] = [];
  for (let at = dirname(path); ; at = dirname(at)) {
    try {
      await lstat(at);
      break;
    } catch (error) {
      if (codeOf(error) !== 'ENOENT') break; // `mkdir` will report the real problem
      missing.unshift(at);
    }
    if (dirname(at) === at) break;
  }
  return missing;
}

/**
 * Remove the directories this call created, deepest first, with `rmdir`: it refuses a directory
 * that is not empty, so it can never delete what another process put there meanwhile. Returns the
 * ones that could not be removed.
 */
async function removeEmpty(created: readonly string[]): Promise<string[]> {
  const left: string[] = [];
  for (const directory of [...created].reverse()) {
    try {
      await rmdir(directory);
    } catch (error) {
      if (codeOf(error) !== 'ENOENT') left.push(directory);
    }
  }
  return left;
}

/**
 * Move one app's on-disk state directory to another place, for example from an old location into
 * {@link ProjectMarker.appStatePathOf}.
 *
 * 🔴 **One `rename`, nothing else.** The move is a single atomic `rename(2)`: afterwards the
 * directory is at `to` exactly as it was, links, modes and bookkeeping files included, and if it
 * fails, the source is exactly as it was. There is no copy, no verification pass and no half-moved
 * state. The operating system also does the hard checks: it refuses a destination inside the
 * source or a non-empty destination, and it compares the directories themselves rather than their
 * spelling, so case-insensitive filesystems and links cannot defeat it.
 *
 * 🔴 **Both paths must be absolute.** A relative path (including `.`, `..` and the empty string)
 * would be read against the current directory, so a caller's bug would move and delete its own
 * working tree. Build the path from a project root, as {@link ProjectMarker.appStatePathOf} does.
 *
 * 🔴 **Same filesystem only.** `rename` cannot cross a device. A move that would is refused with
 * the source untouched; copy it yourself, verify the copy, and remove the source. That is a
 * different operation with different failure modes, and is not folded in here.
 *
 * Refused, with the source's contents and the destination unchanged (a destination reached
 * through a symbolic link into the source can make `mkdir` add a directory inside the source for an
 * instant, which is removed again, so its modification time may change):
 * - a path that is not a non-empty absolute path, or that contains a `..` segment;
 * - a source that does not exist, is not a directory, or is itself a symbolic link;
 * - the same directory given twice (even under different spellings or through a link);
 * - a destination that is the source or inside it;
 * - a destination that is not absent or an empty directory;
 * - a destination on another filesystem.
 *
 * @param from - The directory to move.
 * @param to - Where to move it. Missing parent directories are created, and are removed again if the
 * move then fails (only the
 * directories this call created, and only if still empty).
 * @returns `from` and `to` as given; the source no longer exists.
 * @throws {@link WorkspaceError} in each case listed above, and for any other failure of the move,
 * naming the path and the error code.
 */
export async function migrateAppState(
  from: string,
  to: string,
): Promise<MigrationResult> {
  requireAbsolute(from, 'source (from)');
  requireAbsolute(to, 'destination (to)');

  const source = await statOrAbsent(from, 'source');
  if (source === undefined) {
    throw new WorkspaceError(
      `Refusing to migrate ${from}: it does not exist. Nothing was changed.`,
    );
  }
  if (source.isSymbolicLink() || !source.isDirectory()) {
    throw new WorkspaceError(
      `Refusing to migrate ${from}: it is ${source.isSymbolicLink() ? 'a symbolic link' : 'not a directory'}. ` +
        'Nothing was changed.',
    );
  }

  const destination = await statOrAbsent(to, 'destination');
  // `rename(a, a)` succeeds and moves nothing, which would report a move that did not happen.
  if (
    destination !== undefined &&
    destination.ino === source.ino &&
    destination.dev === source.dev
  ) {
    throw new WorkspaceError(
      `Refusing to migrate ${from} into ${to}: they are the same directory. Nothing was changed.`,
    );
  }

  // Before any `mkdir`: creating the destination's parents inside the source would touch it.
  // `resolve` is safe here: `..` is already refused, so it only folds `//`, `/./` and trailing slashes.
  const lexicalFrom = resolve(from);
  const lexicalTo = resolve(to);
  if (lexicalTo === lexicalFrom || lexicalTo.startsWith(lexicalFrom + sep)) {
    throw new WorkspaceError(
      `Refusing to migrate ${from} into ${to}: the destination is the source or inside it. ` +
        'Nothing was changed.',
    );
  }

  const toCreate = await missingParentsOf(to);
  try {
    await mkdir(dirname(to), { recursive: true });
  } catch (error) {
    await removeEmpty(toCreate);
    throw new WorkspaceError(
      `Creating the parent of ${to} failed (${codeOf(error)}): ${messageOf(error)}. ` +
        'The source was not touched.',
    );
  }

  try {
    await rename(from, to);
  } catch (error) {
    const left = await removeEmpty(toCreate);
    const undone =
      toCreate.length === 0
        ? 'nothing was created'
        : left.length === 0
          ? `${toCreate[0]}, which this call created, was removed`
          : `${left.join(', ')} could not be removed (another process may be using ` +
            'them, or they are not empty); remove them before retrying if they are not wanted';
    const why =
      codeOf(error) === 'EXDEV'
        ? `${from} and ${to} are on different filesystems, which a rename cannot cross`
        : codeOf(error) === 'ENOTEMPTY' || codeOf(error) === 'EEXIST'
          ? `${to} already holds files (merging two stores yields one that opens and is wrong)`
          : codeOf(error) === 'EINVAL'
            ? `${to} cannot be moved there (EINVAL): it is inside ${from}, or the move is otherwise invalid`
            : codeOf(error) === 'ENOTDIR' || codeOf(error) === 'EISDIR'
              ? `${to} exists and is not a directory (a file or a symbolic link is never replaced)`
              : `the move failed (${codeOf(error)}): ${messageOf(error)}`;
    throw new WorkspaceError(
      `Refusing to migrate ${from} into ${to}: ${why}. The source's contents were not changed; ${undone}.`,
    );
  }
  return { from, to };
}
