import { cp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

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

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
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
 * @param from - The directory to move. It must exist.
 * @param to - Where to move it. It must be absent or empty.
 * @returns What was moved; the source has been removed.
 * @throws {@link WorkspaceError} when the source is absent, the destination holds files, or the
 * copy does not match the source. In every one of those cases the source is left untouched.
 */
export async function migrateAppState(
  from: string,
  to: string,
): Promise<MigrationResult> {
  if (!(await exists(from))) {
    throw new WorkspaceError(`Nothing to migrate: ${from} does not exist.`);
  }
  if (await exists(to)) {
    const occupied = await filesUnder(to);
    if (occupied.length > 0) {
      throw new WorkspaceError(
        `Refusing to migrate into ${to}: it already contains ${occupied.length} file(s).\n` +
          'Merging two stores produces one that opens and is wrong. Move or remove the ' +
          'destination first.',
      );
    }
  }

  await mkdir(to, { recursive: true });
  await cp(from, to, { recursive: true });

  // Verify before removing anything. Bytes, not counts: a truncated copy has the right name.
  const source = await filesUnder(from);
  const copied = await filesUnder(to);
  if (source.join('\n') !== copied.join('\n')) {
    throw new WorkspaceError(
      `Migration verification failed: ${from} has ${source.length} file(s), ${to} has ` +
        `${copied.length}. The source has been left untouched.`,
    );
  }
  let bytes = 0;
  for (const file of source) {
    const before = await readFile(join(from, file));
    const after = await readFile(join(to, file));
    if (!before.equals(after)) {
      throw new WorkspaceError(
        `Migration verification failed: ${file} differs after copying. The source has been left ` +
          'untouched.',
      );
    }
    bytes += before.byteLength;
  }

  await rm(from, { recursive: true, force: true });
  return { from, to, files: source.length, bytes };
}
