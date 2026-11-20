import { dirname, resolve } from 'node:path';

import {
  MARKER_FILENAME,
  MARKER_VERSION,
  WorkspaceError,
  readMarkerIn,
  type Workspace,
} from './marker';

/*
 * Finding the project you are standing in.
 *
 * 🔴 **The lookup exists to be able to fail.** What it replaces is usually:
 *
 *   git rev-parse --show-toplevel   // succeeds in ANY git repository
 *   ?? process.cwd()                // succeeds everywhere
 *
 * Neither can answer "no". So a tool run from the wrong place never learns it is somewhere it does
 * not belong, and creates a fresh store there instead. That is survivable while the thing being
 * resolved is a tracked file (a wrong root fails to find it, loudly). It stops being survivable once
 * app state lives under the marker: a wrong root then creates a fresh **empty** store, silently, and
 * an empty store usually reads as "nothing to do", which reports success.
 */

/** Where {@link ProjectMarker.resolveWorkspace} should look. */
export interface ResolveOptions {
  /** Where to start walking. Defaults to the process's current directory. */
  readonly from?: string;
  /**
   * An explicit root, typically taken from an environment variable the caller names.
   *
   * 🔴 **Trusted, and deliberately not required to be a marked project.** What this package removes
   * is *inference*, a guess that always succeeds, not explicit direction; an override is a caller
   * saying "this one". The bound on that trust: it is safe only while nothing sets the override from
   * ambient state. If a shell profile, CI default or wrapper ever sets it for everyone, the guess is
   * back, and the caller must stop passing it through.
   *
   * An empty string counts as absent, so an unset-but-exported variable walks instead.
   */
  readonly override?: string | undefined;
}

/**
 * @internal Walk up from `from` to the nearest marker.
 *
 * Throws when there is none. It does **not** fall back to the cwd, and it creates nothing. A
 * damaged marker on the way up throws rather than being skipped, so the search cannot step past a
 * real project and act on its parent.
 */
export async function findWorkspaceIn(
  directory: string,
  hint: string | undefined,
  from?: string,
): Promise<Workspace> {
  const start = resolve(from ?? process.cwd());
  let current = start;

  for (;;) {
    const found = await readMarkerIn(directory, current);
    if (found) return found;
    const parent = dirname(current);
    // `dirname('/')` is `'/'`: the filesystem root is where the walk ends.
    if (parent === current) break;
    current = parent;
  }

  throw new WorkspaceError(
    `No project found at ${start} or any parent directory: none has ` +
      `${directory}/${MARKER_FILENAME}.` +
      (hint ? `\n${hint}` : ''),
  );
}

/**
 * @internal An explicit override if given, otherwise the walk.
 *
 * One entry point on purpose: two tools resolving a root two ways is how they come to disagree.
 */
export async function resolveWorkspaceIn(
  directory: string,
  hint: string | undefined,
  options: ResolveOptions = {},
): Promise<Workspace> {
  if (options.override) {
    const root = resolve(options.override);
    const marked = await readMarkerIn(directory, root);
    // Trusted: an override that names an unmarked directory is still honoured, and reports a
    // synthetic marker so callers have one shape to handle.
    return (
      marked ?? {
        root,
        marker: { version: MARKER_VERSION, project: 'override' },
      }
    );
  }
  return findWorkspaceIn(directory, hint, options.from);
}
