import { lstat, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';

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
};

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
 * Refused, with nothing changed on either side:
 * - a path that is not a non-empty absolute path;
 * - a source that does not exist, is not a directory, or is itself a symbolic link;
 * - the same directory given twice (even under different spellings or through a link);
 * - a destination inside the source;
 * - a destination that is not absent or an empty directory;
 * - a destination on another filesystem.
 *
 * @param from - The directory to move.
 * @param to - Where to move it. Missing parent directories are created, and are removed again if the
 * move then fails.
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

  let created: string | undefined;
  try {
    // The first directory `mkdir` actually created: removing it removes everything it created.
    created = await mkdir(dirname(to), { recursive: true });
  } catch (error) {
    throw new WorkspaceError(
      `Creating the parent of ${to} failed (${codeOf(error)}): ${messageOf(error)}. ` +
        'The source was not touched.',
    );
  }

  try {
    await rename(from, to);
  } catch (error) {
    const undone =
      created === undefined
        ? 'nothing was created'
        : await rm(created, { recursive: true, force: true }).then(
            () => `${created}, which this call created, was removed`,
            (failure: unknown) =>
              `${created}, which this call created, could not be removed ` +
              `(${messageOf(failure)}); remove it before retrying`,
          );
    const why =
      codeOf(error) === 'EXDEV'
        ? `${from} and ${to} are on different filesystems, which a rename cannot cross`
        : codeOf(error) === 'ENOTEMPTY' || codeOf(error) === 'EEXIST'
          ? `${to} already holds files (merging two stores yields one that opens and is wrong)`
          : codeOf(error) === 'EINVAL'
            ? `${to} is inside ${from}`
            : codeOf(error) === 'ENOTDIR' || codeOf(error) === 'EISDIR'
              ? `${to} exists and is not a directory (a file or a symbolic link is never replaced)`
              : `the move failed (${codeOf(error)}): ${messageOf(error)}`;
    throw new WorkspaceError(
      `Refusing to migrate ${from} into ${to}: ${why}. The source was not touched; ${undone}.`,
    );
  }
  return { from, to };
}
