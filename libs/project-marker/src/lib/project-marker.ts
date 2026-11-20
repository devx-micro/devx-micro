import {
  findWorkspaceIn,
  resolveWorkspaceIn,
  type ResolveOptions,
} from './discovery';
import {
  appStatePathIn,
  markerDirectoryIn,
  markerPathIn,
  readMarkerIn,
  segmentProblem,
  writeMarkerIn,
  type Workspace,
} from './marker';

/** How to bind {@link projectMarker}. */
export interface ProjectMarkerOptions {
  /**
   * The name of the marker directory at a project root, such as `.acme`. **Required, with no
   * default**: two tools that defaulted to the same name would each accept the other's projects.
   *
   * It must be one plain path segment: not empty, not `.` or `..`, with no `/`, `\` or NUL byte, and
   * with no whitespace at either end (so a whitespace-only name is refused too).
   */
  readonly directory: string;
  /**
   * Advice appended, on its own line, to the error raised when no project is found, such as
   * "Run `acme init` in the project root to create one." Leave it out and the error only says what
   * was looked for and where.
   *
   * It is not added to other errors: a damaged or unknown-version marker is not fixed by
   * initialising again, because initialisation refuses to overwrite a marker.
   */
  readonly hint?: string;
}

/**
 * The marker functions, bound to one marker directory. Every function is a plain closure, so it can
 * be destructured and passed around without its object.
 */
export interface ProjectMarker {
  /** The marker directory name this binding was created with. */
  readonly directory: string;
  /** The marker directory at `root`, e.g. `<root>/.acme`. */
  markerDirectoryOf(root: string): string;
  /** The marker file at `root`, e.g. `<root>/.acme/project.json`. */
  markerPathOf(root: string): string;
  /**
   * The state directory for one app, beneath the marker: `<root>/<directory>/<app>`.
   *
   * The app name is the namespace, so two apps sharing a project cannot collide. Nothing is
   * created; this only computes the path.
   *
   * @throws TypeError when `app` is not one plain path segment (empty, `.`, `..`, or holding
   * `/`, `\\` or a NUL byte), or is the marker file's name, {@link MARKER_FILENAME}. Each of those
   * would put an app's state outside its own directory, or on the marker itself.
   */
  appStatePathOf(root: string, app: string): string;
  /**
   * Read the marker at `root`.
   *
   * @returns The project, or `undefined` only when `root` has no marker file at all: the "keep
   * looking" case. That includes a FILE with the marker directory's name (an unrelated config file,
   * or a `.git` file in a worktree), since nothing can be beneath it.
   * @throws {@link WorkspaceError} when a marker file exists but cannot be read, is not valid JSON,
   * lacks `version` or `project`, or has a version other than {@link MARKER_VERSION}. A damaged
   * marker is never treated as absent, because a search that skipped it would act on the parent
   * project instead.
   */
  readMarker(root: string): Promise<Workspace | undefined>;
  /**
   * Create the marker at `root`. **Idempotent**: an existing valid marker is returned unchanged,
   * with `created: false`, even when `project` differs. A person may have edited the project name,
   * and initialising again must not quietly undo that.
   *
   * @param project - The project name; defaults to the base name of `root`.
   * @throws {@link WorkspaceError} with code `invalid-project-name` when `project` is empty or
   * contains whitespace or a colon (nothing else is checked: `a/b` and `.` pass); with code `no-workspace` when a damaged marker is already there,
   * which is refused rather than repaired.
   */
  writeMarker(
    root: string,
    project?: string,
  ): Promise<{ workspace: Workspace; created: boolean }>;
  /**
   * Walk up from `from` (default: the current directory) to the nearest marker.
   *
   * 🔴 It never guesses. With no marker in `from` or any parent it throws, rather than falling back
   * to the current directory or a version-control root, and it creates nothing. A damaged marker on
   * the way up throws too, rather than being stepped over.
   *
   * @throws {@link WorkspaceError} when there is no project, naming the marker it looked for and
   * ending with the binding's hint, if it has one.
   */
  findWorkspace(from?: string): Promise<Workspace>;
  /**
   * The resolution a tool should use: an explicit override if one is given, otherwise
   * {@link ProjectMarker.findWorkspace}.
   *
   * An override is trusted (see {@link ResolveOptions.override}): if it names an unmarked
   * directory, that directory is still returned, with the synthetic marker
   * `{ version: MARKER_VERSION, project: 'override' }`.
   */
  resolveWorkspace(options?: ResolveOptions): Promise<Workspace>;
}

const assertDirectoryName = (directory: unknown): string => {
  if (segmentProblem(directory) !== undefined) {
    throw new TypeError(
      `projectMarker: "directory" must be one plain path segment, such as ".acme"; got ` +
        `${JSON.stringify(directory) ?? String(directory)}.`,
    );
  }
  return directory as string;
};

/**
 * Bind the marker functions to one marker directory name.
 *
 * Call it once, at the edge of your tool, and use the returned functions everywhere else:
 *
 * ```ts
 * export const { findWorkspace, resolveWorkspace, appStatePathOf } = projectMarker({
 *   directory: '.acme',
 *   hint: 'Run `acme init` in the project root to create one.',
 * });
 * ```
 *
 * A factory rather than a `directory` argument on every function: the name is a property of the
 * tool, not of each call, so it is stated once, and a call site cannot pass the wrong one.
 *
 * @throws TypeError when `options.directory` is missing or is not one plain path segment (see
 * {@link ProjectMarkerOptions.directory}).
 */
export function projectMarker(options: ProjectMarkerOptions): ProjectMarker {
  const directory = assertDirectoryName(
    (options as Partial<ProjectMarkerOptions> | undefined)?.directory,
  );
  const hint = options.hint;
  return {
    directory,
    markerDirectoryOf: (root) => markerDirectoryIn(directory, root),
    markerPathOf: (root) => markerPathIn(directory, root),
    appStatePathOf: (root, app) => appStatePathIn(directory, root, app),
    readMarker: (root) => readMarkerIn(directory, root),
    writeMarker: (root, project) => writeMarkerIn(directory, root, project),
    findWorkspace: (from) => findWorkspaceIn(directory, hint, from),
    resolveWorkspace: (resolveOptions) =>
      resolveWorkspaceIn(directory, hint, resolveOptions),
  };
}
