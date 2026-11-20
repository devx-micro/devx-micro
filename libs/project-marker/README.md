# @devx-micro/project-marker

Finds the project a command-line tool is standing in, by walking up to a **marker file** that the
tool's own `init` wrote, and fails loudly when there is none. It also keeps per-app state beneath
that marker, and moves existing state there safely.

## Install

```bash
npm install @devx-micro/project-marker
```

It has no dependencies: it uses only Node's built-in `fs` and `path`.

## Why a marker

The usual way to find a project root is `git rev-parse --show-toplevel`, falling back to
`process.cwd()`. Both always succeed. A tool run from the wrong directory never learns it is
somewhere it does not belong: it creates a fresh, **empty** store there and reports success on
nothing. A marker can be absent, so a lookup can say "there is no project here", and that is the
whole point of this package.

A marker is `<root>/<directory>/project.json`:

```json
{
  "version": 1,
  "project": "my-project"
}
```

## Usage

Bind the functions to your tool's marker directory **once**, and import them from there:

```ts
// marker.ts
import { projectMarker } from '@devx-micro/project-marker';

export const { findWorkspace, resolveWorkspace, readMarker, writeMarker, appStatePathOf } = projectMarker({
  directory: '.acme',
  hint: 'Run `acme init` in the project root to create one.',
});
export { WorkspaceError, migrateAppState, type Workspace } from '@devx-micro/project-marker';
```

```ts
// acme init
const { workspace, created } = await writeMarker(process.cwd());

// any other acme command
const { root } = await resolveWorkspace({
  override: process.env['ACME_ROOT'],
});
const storePath = appStatePathOf(root, 'store'); // <root>/.acme/store
```

### Why a factory, and why `directory` has no default

The marker directory name belongs to the **tool**, not to each call. Binding it once means it is
written in one place, and no call site can pass a different one by mistake. The alternative, a
`directory` argument on every function, adds the same argument to every call in the codebase and
lets two calls disagree. The bound functions are plain closures, so they can be destructured and
re-exported, and existing code that calls `findWorkspace(...)` keeps calling `findWorkspace(...)`.

There is no default, because two tools that shared one would each accept the other's projects. A
tool that finds a project must find **its own**.

`directory` must be one plain path segment, or `projectMarker` throws a `TypeError`: not empty, not
`.` or `..`, with no `/`, `\` or NUL byte, and no whitespace at either end (so a whitespace-only
name is refused too).

## Behaviour

| Function                                        | What it does                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `findWorkspace(from?)`                          | Walks up from `from` (default: the current directory) to the nearest marker. Throws `WorkspaceError` if there is none, naming the marker it looked for and ending with your `hint`. Never falls back to the cwd; creates nothing.                                                                                 |
| `resolveWorkspace({ from, override })`          | An explicit `override` root if given (trusted, even if unmarked), otherwise `findWorkspace(from)`. An empty override counts as absent.                                                                                                                                                                            |
| `readMarker(root)`                              | The project at `root`, or `undefined` only when there is no marker file at all. A **file** with the marker directory's name (an unrelated config file, a `.git` file in a worktree) holds no marker, so it reads as absent and the walk continues past it.                                                        |
| `writeMarker(root, project?)`                   | Creates the marker; the project name defaults to the base name of `root`. Idempotent: an existing valid marker is returned unchanged with `created: false`.                                                                                                                                                       |
| `appStatePathOf(root, app)`                     | `<root>/<directory>/<app>`. Computes the path only. Throws `TypeError` unless `app` is one plain path segment (not empty, not `.` or `..`, with no `/`, `\` or NUL byte, and no whitespace at either end) other than `project.json`, so an app's state can never land outside its own directory or on the marker. |
| `markerDirectoryOf(root)`, `markerPathOf(root)` | The marker directory and file at `root`.                                                                                                                                                                                                                                                                          |
| `migrateAppState(from, to)`                     | Moves a state directory with one atomic `rename`. Both paths must be absolute, on one filesystem. Not bound to a directory name.                                                                                                                                                                                  |

### Failures are loud, on purpose

- **A damaged marker is never skipped.** A marker file that cannot be read, is not JSON, lacks
  `version` or `project`, or has an unknown version throws `WorkspaceError`. Treating it as absent
  would let a search walk past a real project and act on its parent.
- **An unknown marker version is refused**, not interpreted. The package understands
  `MARKER_VERSION` (1) only.
- **A marker is never rewritten.** `writeMarker` leaves an existing marker alone even if you pass a
  different name, since a person may have edited it; a damaged one is refused, not repaired.
- **A project name is checked when a marker is written**: it must be non-empty, with no whitespace
  and no colon, so it can namespace identifiers. That is the whole rule (`a/b` and `.` pass).
  Anything else throws `WorkspaceError` with code `invalid-project-name`. **Reading does not
  check it**: a marker someone edited by hand still opens, so check the name yourself if you build
  identifiers from it.

### Migrating state

`migrateAppState(from, to)` is **one atomic `rename`**: afterwards the directory is at `to` exactly
as it was (bookkeeping files, links and modes included), and if it fails the source is exactly as
it was. There is no copy, no verification pass and no half-moved state. The operating system does
the hard checks, comparing the directories themselves rather than their spelling, so links and
case-insensitive filesystems cannot defeat them.

**Both paths must be absolute.** A relative path, including `.`, `..` and the empty string, would
be read against the current directory, so a caller's bug could move its own working tree. Build the
path from a project root, as `appStatePathOf` does.

**Same filesystem only.** `rename` cannot cross a device; that case is refused with the source
untouched. Copy, verify and remove it yourself if you need it: it is a different operation with
different failure modes.

It refuses, leaving both sides as they were, when:

- a path is not a non-empty absolute path;
- `from` does not exist, is not a directory, or is itself a symbolic link;
- `from` and `to` are the same directory, under any spelling or through a link;
- `to` is inside `from`;
- `to` already holds files (merging two stores yields one that opens and is wrong), or exists and
  is a file or a link (neither is ever replaced);
- `to` is on another filesystem.

Missing parents of `to` are created, and removed again if the move then fails. Every refusal throws
`WorkspaceError`, and its message says which case it was.

`WorkspaceError` carries a `code` (`no-workspace` or `invalid-project-name`) so a transport can
report it as itself rather than as a generic failure. Your own code may throw it too, for its own
"no usable project" cases.
