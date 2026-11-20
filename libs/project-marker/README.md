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

| Function                                        | What it does                                                                                                                                                                                                                                                                 |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `findWorkspace(from?)`                          | Walks up from `from` (default: the current directory) to the nearest marker. Throws `WorkspaceError` if there is none, naming the marker it looked for and ending with your `hint`. Never falls back to the cwd; creates nothing.                                            |
| `resolveWorkspace({ from, override })`          | An explicit `override` root if given (trusted, even if unmarked), otherwise `findWorkspace(from)`. An empty override counts as absent.                                                                                                                                       |
| `readMarker(root)`                              | The project at `root`, or `undefined` only when there is no marker file at all. A **file** with the marker directory's name (an unrelated config file, a `.git` file in a worktree) holds no marker, so it reads as absent and the walk continues past it.                   |
| `writeMarker(root, project?)`                   | Creates the marker; the project name defaults to the base name of `root`. Idempotent: an existing valid marker is returned unchanged with `created: false`.                                                                                                                  |
| `appStatePathOf(root, app)`                     | `<root>/<directory>/<app>`. Computes the path only. Throws `TypeError` unless `app` is one plain path segment (not empty, `.` or `..`, with no `/`, `\` or NUL byte) other than `project.json`, so an app's state can never land outside its own directory or on the marker. |
| `markerDirectoryOf(root)`, `markerPathOf(root)` | The marker directory and file at `root`.                                                                                                                                                                                                                                     |
| `migrateAppState(from, to)`                     | Moves a state directory: copy, verify, then remove. Not bound to a directory name.                                                                                                                                                                                           |

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

`migrateAppState(from, to)` **copies, verifies, and only then removes.** It compares the file list
and the bytes of every file, because embedded stores keep lock, log and manifest files beside their
data, and a copy missing any of them is corrupt rather than partial.

**Each path is resolved once, as the operating system resolves it**, and that one real path is
used for every check and every change. This matters for `..`: `<link>/../x` means `x` beside the
link's **target**, not beside the link, and a check that read it one way while the copy read it the
other could put the copy inside the source. Links earlier in either path are followed as the
operating system follows them; a link as the **last** component of either path is refused.

It refuses, **before changing anything on either side** (the message ends "Nothing was changed"),
when:

- `from` does not exist, is not a directory, or is itself a symbolic link;
- `from` holds a **symbolic link** anywhere, or any other special file (pipe, socket, device). A link
  cannot be verified by reading through it, and a copied link can dangle once the source is
  removed, so links are refused rather than copied. Replace them with what they point to, or remove
  them, and migrate again;
- `to` is a **symbolic link**, even a dangling one or one to an empty directory. Name the directory
  it points to instead; the link itself is never deleted;
- `to` exists and is not a directory, or already holds files (merging two stores yields one that
  opens and is wrong);
- a component of `to`'s path is a file, or a link to nothing;
- `to` uses `..` after a component that does not exist yet, so it has no single meaning;
- `from` and `to` overlap: one inside the other, or the same directory, compared on the resolved
  paths;
- a path cannot be inspected, for example a directory in either tree that cannot be read
  (`EACCES`). The message names the path and the error code.

If creating the destination, the copy or its verification fails, the **source is untouched**, and:

- if this call **created directories** for the destination (`to` and any missing parents), the
  first one it created is **removed**, which removes the rest, so you can simply run it again. The
  message names the directory it removed;
- if it **created nothing** (for example, a parent could not be written), the message says
  "nothing was created";
- a destination that **already existed** (empty) is **left as it is**, and may hold a partial copy;
  empty it before retrying;
- if that cleanup itself fails, the message names what to remove before retrying.

If only removing the source fails, the copy is complete and verified, and the source may be partly
removed; the error says so, and the rest must be removed by hand.

Every one of these failures throws `WorkspaceError`, and its message says which case it was.

`WorkspaceError` carries a `code` (`no-workspace` or `invalid-project-name`) so a transport can
report it as itself rather than as a generic failure. Your own code may throw it too, for its own
"no usable project" cases.
