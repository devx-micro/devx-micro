import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

/*
 * The project marker: a small file at a project root that says "this directory is a project".
 *
 * 🔴 **The point of this file is that a project can be ABSENT.** The usual way to find a project
 * root is `git rev-parse --show-toplevel` against the caller's cwd, falling back to
 * `process.cwd()`. Both always succeed. `git rev-parse` succeeds in *any* git repository, so a tool
 * run from the wrong place never discovers it is somewhere it does not belong, and creates a fresh
 * store there instead.
 *
 * A marker that can be missing replaces a guess that always succeeds.
 */

/**
 * The file inside the marker directory that makes a directory a project.
 *
 * A bare marker directory proves nothing: tools create directories for many reasons, and an empty
 * one may be left over from a failed initialisation.
 */
export const MARKER_FILENAME = 'project.json';

/**
 * The only marker format this package understands.
 *
 * 🔴 Written into every marker so a later change is **detectable rather than guessed**. A reader
 * that meets a version it does not know says so and stops, rather than interpreting an unknown
 * format as if it were this one.
 */
export const MARKER_VERSION = 1;

/** The contents of a marker file. */
export interface WorkspaceMarker {
  /** The marker format; always {@link MARKER_VERSION} for a marker this package accepts. */
  readonly version: number;
  /**
   * The project's name: one segment, with no whitespace and no colon. Free text a person may edit;
   * see {@link ProjectMarker.writeMarker} for why it is never rewritten.
   */
  readonly project: string;
}

/** A project that was found: where it is, and what its marker says. */
export interface Workspace {
  /** The project root: the directory that contains the marker directory. */
  readonly root: string;
  /** The marker read at {@link Workspace.root}. */
  readonly marker: WorkspaceMarker;
}

/**
 * Why a {@link WorkspaceError} was raised.
 *
 * - `no-workspace`: there is no usable project here (absent, unreadable, damaged, unknown version),
 *   or state could not be migrated.
 * - `invalid-project-name`: a marker was refused because its project name is not one plain segment.
 */
export type WorkspaceErrorCode = 'no-workspace' | 'invalid-project-name';

/**
 * Raised for every "this is not a usable project" case. Callers report it to a person; they do not
 * recover from it.
 *
 * Consumers may also raise it themselves, for their own "no usable project" cases, so that one
 * `instanceof` check covers them all.
 */
export class WorkspaceError extends Error {
  /**
   * 🔴 So a transport can report this error as itself rather than as a generic failure. Without a
   * code, "this directory is not a project" and "the store is broken" reach a caller as the same
   * thing, with the message as the only difference, and a message is not a contract.
   */
  public readonly code: WorkspaceErrorCode;

  /**
   * @param message - What is wrong, for a person to read.
   * @param code - Why; defaults to `no-workspace`.
   */
  public constructor(
    message: string,
    code: WorkspaceErrorCode = 'no-workspace',
  ) {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
  }
}

/** @internal The marker directory at `root`. */
export const markerDirectoryIn = (directory: string, root: string): string =>
  join(root, directory);

/** @internal The marker file at `root`. */
export const markerPathIn = (directory: string, root: string): string =>
  join(root, directory, MARKER_FILENAME);

/**
 * @internal One app's state directory, beneath the marker.
 *
 * The app name is the namespace, so two apps sharing a project cannot collide.
 */
export const appStatePathIn = (
  directory: string,
  root: string,
  app: string,
): string => join(root, directory, app);

/**
 * @internal Read the marker at `root`, or explain why it is not a project.
 *
 * Returns `undefined` only when there is no marker file at all: the ordinary "keep walking" case
 * for a caller searching upward. Everything else **throws**. A directory with a marker file that is
 * unreadable, malformed or of an unknown version is a damaged project, not a candidate to skip.
 * Walking past it would take the search to a parent and silently act on the wrong project.
 */
export async function readMarkerIn(
  directory: string,
  root: string,
): Promise<Workspace | undefined> {
  const path = markerPathIn(directory, root);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new WorkspaceError(
      `Cannot read the project marker at ${path}: ${(error as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new WorkspaceError(
      `The project marker at ${path} is not valid JSON: ${(error as Error).message}`,
    );
  }

  const marker = parsed as Partial<WorkspaceMarker> | null;
  if (
    typeof marker?.version !== 'number' ||
    typeof marker?.project !== 'string'
  ) {
    throw new WorkspaceError(
      `The project marker at ${path} is missing "version" or "project".`,
    );
  }
  if (marker.version !== MARKER_VERSION) {
    throw new WorkspaceError(
      `The project marker at ${path} is version ${marker.version}; this build understands ` +
        `version ${MARKER_VERSION}. Upgrade the tool that reads it.`,
    );
  }
  return {
    root,
    marker: { version: marker.version, project: marker.project },
  };
}

/**
 * @internal Create the marker at `root`. **Idempotent**: an existing, valid marker is left exactly
 * as it is.
 *
 * 🔴 Initialising again must never rewrite a marker in place. `project` is free text a person may
 * have edited, and silently replacing it would make initialisation a destructive command that looks
 * safe. A damaged marker is refused (by {@link readMarkerIn}) rather than repaired, for the same
 * reason.
 */
export async function writeMarkerIn(
  directory: string,
  root: string,
  project = basename(root),
): Promise<{ workspace: Workspace; created: boolean }> {
  const existing = await readMarkerIn(directory, root);
  if (existing) return { workspace: existing, created: false };
  // 🔴 A project name is a namespace for whatever a consumer keys by it: one segment, no
  // whitespace, no colon. Without this check a directory named `My Docs` is marked as `My Docs`,
  // and every identifier later built from that name is refused downstream, far from the cause.
  if (!/^[^\s:]+$/.test(project)) {
    throw new WorkspaceError(
      `'${project}' cannot name a project: a project name is one segment with no whitespace and no ` +
        'colon, because it namespaces identifiers built from it. Rename the directory and ' +
        'initialise again.',
      'invalid-project-name',
    );
  }

  const marker: WorkspaceMarker = { version: MARKER_VERSION, project };
  await mkdir(markerDirectoryIn(directory, root), { recursive: true });
  await writeFile(
    markerPathIn(directory, root),
    `${JSON.stringify(marker, null, 2)}\n`,
    'utf8',
  );
  return { workspace: { root, marker }, created: true };
}
