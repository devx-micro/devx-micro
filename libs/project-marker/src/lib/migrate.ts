import type { Stats } from 'node:fs';
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
import { dirname, isAbsolute, join, parse, relative, sep } from 'node:path';

import { WorkspaceError } from './marker';

/** What {@link migrateAppState} moved. */
export interface MigrationResult {
  /** The source directory, as given, which no longer exists. */
  readonly from: string;
  /** The destination directory, as given. */
  readonly to: string;
  /** How many files were copied and verified. */
  readonly files: number;
  /** Their total size, in bytes. */
  readonly bytes: number;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const codeOf = (error: unknown): string =>
  (error as NodeJS.ErrnoException | undefined)?.code ?? 'unknown error';

/**
 * Run a read-only inspection, turning any filesystem error into a {@link WorkspaceError} that names
 * the path and the error code. Inspection happens before anything is changed, so it says so.
 */
async function inspecting<T>(path: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    const where = (error as NodeJS.ErrnoException).path ?? path;
    throw new WorkspaceError(
      `Cannot inspect ${where} (${codeOf(error)}): ${messageOf(error)}. Nothing was changed.`,
    );
  }
}

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
async function regularFilesUnder(
  from: string,
  suffix: '' | ' Nothing was changed.',
): Promise<string[]> {
  const found: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const name = relative(from, path);
      if (entry.isSymbolicLink()) {
        throw new WorkspaceError(
          `Refusing to migrate ${from}: ${name} is a symbolic link, and a link cannot be verified ` +
            'by reading through it. Replace it with the file or directory it points to, or ' +
            `remove it, and migrate again.${suffix}`,
        );
      }
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) found.push(name);
      else {
        throw new WorkspaceError(
          `Refusing to migrate ${from}: ${name} is not a regular file or directory.${suffix}`,
        );
      }
    }
  };
  await walk(from);
  return found.sort();
}

/** How {@link resolveOnce} found a path. */
type Resolution =
  /** The whole path exists. `path` is real; `link` says whether its LAST component is a link. */
  | { kind: 'found'; path: string; link: boolean; stats: Stats }
  /**
   * The path does not exist. `path` is where it would be (real up to `firstMissing`, the first
   * component that does not exist). `climbs` says a `..` follows a missing component.
   */
  | { kind: 'missing'; path: string; firstMissing: string; climbs: boolean }
  /** A component other than the last cannot be passed through. */
  | {
      kind: 'blocked';
      at: string;
      why: 'is not a directory' | 'is a symbolic link to nothing';
    };

/**
 * Resolve `path` once, the way the operating system does, into one canonical absolute path.
 *
 * 🔴 **Why not `path.resolve` then `realpath`.** `resolve` removes `..` as text, but the operating
 * system applies `..` AFTER following a link: `<link>/..` is the parent of the link's TARGET. A
 * check that reads the path one way and a `mkdir` that reads it the other act on different
 * directories. So the path is walked one component at a time from the root, following each link as
 * the operating system would, and the result is used for every later step.
 *
 * The last component is examined but not followed, so a caller can refuse a link there. A `..`
 * after a component that does not exist has no meaning yet, and is reported as `climbs`.
 */
async function resolveOnce(given: string): Promise<Resolution> {
  // Join with the cwd as TEXT: `path.resolve` would already have removed `..`.
  const absolute = isAbsolute(given) ? given : `${process.cwd()}${sep}${given}`;
  const { root } = parse(absolute);
  const segments = absolute
    .slice(root.length)
    .split(/[\\/]+/)
    .filter((segment) => segment !== '');

  let current = await inspecting(root, () => realpath(root));
  let firstMissing: string | undefined;
  const missing: string[] = [];
  let climbs = false;

  for (const [index, segment] of segments.entries()) {
    const last = index === segments.length - 1;
    if (firstMissing !== undefined) {
      if (segment === '..') climbs = true;
      else if (segment !== '.') missing.push(segment);
      continue;
    }
    if (segment === '.') continue;
    if (segment === '..') {
      // `current` is real, so its parent is what the operating system means by `..` here.
      current = dirname(current);
      continue;
    }

    const candidate = join(current, segment);
    const stats = await inspecting(candidate, () =>
      lstat(candidate).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      }),
    );
    if (!stats) {
      firstMissing = candidate;
      missing.push(segment);
      continue;
    }
    if (last) {
      return {
        kind: 'found',
        path: candidate,
        link: stats.isSymbolicLink(),
        stats,
      };
    }
    if (stats.isSymbolicLink()) {
      const target = await inspecting(candidate, () =>
        realpath(candidate).catch((error: NodeJS.ErrnoException) => {
          if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code ?? '')) {
            return undefined;
          }
          throw error;
        }),
      );
      if (target === undefined) {
        return {
          kind: 'blocked',
          at: candidate,
          why: 'is a symbolic link to nothing',
        };
      }
      const targetStats = await inspecting(target, () => stat(target));
      if (!targetStats.isDirectory()) {
        return { kind: 'blocked', at: candidate, why: 'is not a directory' };
      }
      current = target;
      continue;
    }
    if (!stats.isDirectory()) {
      return { kind: 'blocked', at: candidate, why: 'is not a directory' };
    }
    current = candidate;
  }

  if (firstMissing !== undefined) {
    return {
      kind: 'missing',
      path: join(current, ...missing),
      firstMissing,
      climbs,
    };
  }
  // The path ended in `.` or `..` (or is the root): `current` is a real directory.
  const stats = await inspecting(current, () => lstat(current));
  return { kind: 'found', path: current, link: false, stats };
}

const isWithin = (child: string, parent: string): boolean => {
  const rel = relative(parent, child);
  return (
    rel === '' ||
    (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
};

/** Resolve the source, or refuse it. Returns its real path. */
async function resolveSource(from: string): Promise<string> {
  const source = await resolveOnce(from);
  if (source.kind !== 'found') {
    const why =
      source.kind === 'blocked' ? ` (${source.at} ${source.why})` : '';
    throw new WorkspaceError(
      `Nothing to migrate: ${from} does not exist${why}. Nothing was changed.`,
    );
  }
  if (source.link) {
    throw new WorkspaceError(
      `Refusing to migrate ${from}: it is a symbolic link. Migrate the directory it points to. ` +
        'Nothing was changed.',
    );
  }
  if (!source.stats.isDirectory()) {
    throw new WorkspaceError(
      `Refusing to migrate ${from}: it is not a directory. Nothing was changed.`,
    );
  }
  return source.path;
}

/**
 * Resolve the destination, or refuse it. Returns its real path, and the first directory that
 * would have to be created for it (`undefined` when it already exists).
 */
async function resolveDestination(
  to: string,
): Promise<{ path: string; firstMissing: string | undefined }> {
  const destination = await resolveOnce(to);
  if (destination.kind === 'blocked') {
    throw new WorkspaceError(
      `Refusing to migrate into ${to}: ${destination.at} ${destination.why}. Nothing was ` +
        'changed.',
    );
  }
  if (destination.kind === 'missing') {
    if (destination.climbs) {
      throw new WorkspaceError(
        `Refusing to migrate into ${to}: it uses \`..\` after ${destination.firstMissing}, ` +
          'which does not exist, so it has no single meaning. Nothing was changed.',
      );
    }
    return { path: destination.path, firstMissing: destination.firstMissing };
  }
  // 🔴 Decided with `lstat`: a link here, even a dangling one, is refused and never deleted.
  if (destination.link) {
    throw new WorkspaceError(
      `Refusing to migrate into ${to}: it is a symbolic link. Name the directory it points ` +
        'to instead. Nothing was changed.',
    );
  }
  if (!destination.stats.isDirectory()) {
    throw new WorkspaceError(
      `Refusing to migrate into ${to}: it exists and is not a directory. Nothing was changed.`,
    );
  }
  return { path: destination.path, firstMissing: undefined };
}

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
 * 🔴 **Each path is resolved once, as the operating system resolves it**, and that one real path is
 * used for every check and every change. `<link>/..` is the parent of the link's target, not of the
 * link; reading it one way to check overlap and another way to copy is how a copy lands inside the
 * source.
 *
 * 🔴 **No symbolic links at either end.** A link anywhere inside the source, a source or
 * destination that is itself a link (even a dangling one), or a path that passes through a link to
 * nothing, is refused. A link cannot be verified by reading through it, a copied link can dangle
 * once the source is removed, and a link at the destination could be deleted by mistake. Links
 * EARLIER in either path are followed, as the operating system follows them.
 *
 * **What each failure leaves behind.** Every failure throws {@link WorkspaceError}, and its message
 * says which case it was:
 *
 * - **Refused before any change; nothing is changed on either side:**
 *   - the source does not exist, is not a directory, is a link, or holds a link or special file;
 *   - the destination is a link, exists and is not a directory, or already holds files;
 *   - a component of the destination's path is a file, or a link to nothing;
 *   - the destination uses `..` after a component that does not exist;
 *   - the two overlap (one inside the other, or the same directory);
 *   - a path cannot be inspected (for example `EACCES` on a directory in either tree).
 * - **Creating the destination, copying or verifying fails:** the source is **untouched**. If this
 *   call created directories for the destination, the first one it created (which holds any others
 *   it created) is **removed**, so the migration can simply be run again. A destination that
 *   existed (empty) before the call is **left as it is**, and may hold a partial copy; empty it
 *   before retrying. If nothing was created, the message says so. If the cleanup itself fails, the
 *   message names what to remove.
 * - **Removing the source fails, after a verified copy:** the copy is **complete**, and the source
 *   may be partly removed; remove the rest by hand.
 *
 * @param from - The directory to move. It must exist and hold only regular files and directories.
 * @param to - Where to move it. It must be absent or an empty directory, must not be a symbolic
 * link, and must not overlap `from`. Missing parent directories are created.
 * @returns What was moved, with `from` and `to` as given; the source has been removed.
 * @throws {@link WorkspaceError} in each case listed above.
 */
export async function migrateAppState(
  from: string,
  to: string,
): Promise<MigrationResult> {
  const source = await resolveSource(from);
  const { path: destination, firstMissing } = await resolveDestination(to);

  if (isWithin(destination, source) || isWithin(source, destination)) {
    throw new WorkspaceError(
      `Refusing to migrate ${from} into ${to}: the two overlap (one is inside the other, or they ` +
        'are the same directory). Nothing was changed.',
    );
  }

  const existed = firstMissing === undefined;
  if (existed) {
    const occupied = await inspecting(destination, () =>
      filesUnder(destination),
    );
    if (occupied.length > 0) {
      throw new WorkspaceError(
        `Refusing to migrate into ${to}: it already contains ${occupied.length} file(s).\n` +
          'Merging two stores produces one that opens and is wrong. Move or remove the ' +
          'destination first. Nothing was changed.',
      );
    }
  }

  const files = await inspecting(source, () =>
    regularFilesUnder(source, ' Nothing was changed.'),
  );

  let created: string | undefined;
  let bytes = 0;
  try {
    try {
      // The first directory `mkdir` actually created: removing it removes everything it created.
      created = await mkdir(destination, { recursive: true });
    } catch (error) {
      // It may have created some directories before failing; the first missing one is ours.
      if (firstMissing !== undefined) {
        const now = await lstat(firstMissing).catch(() => undefined);
        if (now) created = firstMissing;
      }
      throw new WorkspaceError(
        `Creating ${destination} failed (${codeOf(error)}): ${messageOf(error)}.`,
      );
    }
    try {
      await cp(source, destination, {
        recursive: true,
        verbatimSymlinks: true,
      });
    } catch (error) {
      throw new WorkspaceError(
        `Copying ${source} to ${destination} failed (${codeOf(error)}): ${messageOf(error)}.`,
      );
    }

    // Verify before removing anything. Bytes, not counts: a truncated copy has the right name.
    // The source is listed again, so anything that appeared in it during the copy is caught too.
    const listed = await regularFilesUnder(source, '');
    const copied = await filesUnder(destination);
    if (
      listed.join('\n') !== files.join('\n') ||
      copied.join('\n') !== files.join('\n')
    ) {
      throw new WorkspaceError(
        `Migration verification failed: ${source} has ${listed.length} file(s), ${destination} ` +
          `has ${copied.length}.`,
      );
    }
    for (const file of files) {
      const before = await readFile(join(source, file));
      const after = await readFile(join(destination, file));
      if (!before.equals(after)) {
        throw new WorkspaceError(
          `Migration verification failed: ${file} differs after copying.`,
        );
      }
      bytes += before.byteLength;
    }
  } catch (error) {
    const cleanup = existed
      ? `${destination} existed before this call and has been left as it is; it may hold a ` +
        'partial copy, so empty it before retrying'
      : created === undefined
        ? 'nothing was created'
        : await rm(created, { recursive: true, force: true }).then(
            () => `${created}, which this call created, was removed`,
            (failure: unknown) =>
              `${created}, which this call created, could not be removed ` +
              `(${messageOf(failure)}); remove it before retrying`,
          );
    const reason =
      error instanceof WorkspaceError
        ? error.message
        : `Migrating ${source} to ${destination} failed (${codeOf(error)}): ${messageOf(error)}.`;
    throw new WorkspaceError(
      `${reason} The source has been left untouched; ${cleanup}.`,
    );
  }

  try {
    await rm(source, { recursive: true, force: true });
  } catch (error) {
    throw new WorkspaceError(
      `The copy at ${destination} is complete and verified, but removing ${source} failed ` +
        `(${codeOf(error)}): ${messageOf(error)}. ${source} may be partly removed; remove the ` +
        'rest by hand.',
    );
  }
  return { from, to, files: files.length, bytes };
}
