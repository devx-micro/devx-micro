import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MARKER_FILENAME, MARKER_VERSION, WorkspaceError } from './marker';
import { projectMarker } from './project-marker';

const DIRECTORY = '.example';
const { appStatePathOf, markerPathOf, readMarker, writeMarker } = projectMarker(
  { directory: DIRECTORY },
);

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'project-marker-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const putMarker = (contents: string) => {
  mkdirSync(join(root, DIRECTORY), { recursive: true });
  writeFileSync(markerPathOf(root), contents, 'utf8');
};

describe('a directory with no marker', () => {
  /**
   * 🔴 The case the package exists for. `undefined` means "not a project here", not "close enough",
   * and it is what lets a caller keep walking instead of guessing.
   */
  it('is not a project, and says so by returning undefined', async () => {
    await expect(readMarker(root)).resolves.toBeUndefined();
  });

  it('is not a project just because the marker directory exists', async () => {
    mkdirSync(join(root, DIRECTORY), { recursive: true });
    await expect(readMarker(root)).resolves.toBeUndefined();
  });

  /**
   * 🔴 A plain FILE with the marker directory's name holds no marker: there is nothing at
   * `<directory>/project.json`. It is common once the name is a parameter (an older tool's config
   * file of the same name, or a `.git` file in a worktree), so it must read as absent, not as a
   * damaged project that stops the walk.
   */
  it('is not a project when a file, not a directory, has the marker directory’s name', async () => {
    writeFileSync(join(root, DIRECTORY), 'an unrelated config file\n');
    await expect(readMarker(root)).resolves.toBeUndefined();
  });

  it('is not a project when the root itself is a file', async () => {
    const file = join(root, 'a-file');
    writeFileSync(file, '');
    await expect(readMarker(file)).resolves.toBeUndefined();
  });
});

/**
 * 🔴 A damaged marker throws rather than returning undefined, and the difference matters.
 *
 * `undefined` tells a searching caller to keep walking. If a damaged marker returned it, the search
 * would step past a real project and act on its PARENT: silently operating on the wrong project,
 * which is the exact class of failure a marker exists to remove.
 */
describe('a damaged marker is a hard failure, not a skip', () => {
  it('rejects invalid JSON', async () => {
    putMarker('{ not json');
    await expect(readMarker(root)).rejects.toThrow(WorkspaceError);
    await expect(readMarker(root)).rejects.toThrow(/not valid JSON/);
  });

  it('rejects a marker missing its fields', async () => {
    putMarker(JSON.stringify({ version: MARKER_VERSION }));
    await expect(readMarker(root)).rejects.toThrow(
      /missing "version" or "project"/,
    );
  });

  it('rejects a version it does not understand, and says which', async () => {
    putMarker(JSON.stringify({ version: 99, project: 'x' }));
    await expect(readMarker(root)).rejects.toThrow(WorkspaceError);
    await expect(readMarker(root)).rejects.toThrow(/version 99/);
    await expect(readMarker(root)).rejects.toThrow(
      new RegExp(`understands version ${MARKER_VERSION}`),
    );
  });

  it('rejects a marker it cannot read, rather than treating it as absent', async () => {
    // A directory where the marker FILE should be, inside a real marker directory: something
    // occupies the marker's own name, so this is a damaged marker, not an absent one.
    mkdirSync(markerPathOf(root), { recursive: true });
    await expect(readMarker(root)).rejects.toThrow(WorkspaceError);
    await expect(readMarker(root)).rejects.toThrow(/Cannot read/);
  });
});

describe('writing the marker', () => {
  it('creates a project and reads back the same thing', async () => {
    const { workspace, created } = await writeMarker(root, 'demo');
    expect(created).toBe(true);
    expect(workspace.marker).toEqual({
      version: MARKER_VERSION,
      project: 'demo',
    });
    await expect(readMarker(root)).resolves.toEqual(workspace);
  });

  it('writes the marker file inside the marker directory', async () => {
    await writeMarker(root, 'demo');
    expect(markerPathOf(root)).toBe(join(root, DIRECTORY, MARKER_FILENAME));
  });

  it('defaults the project name to the directory name', async () => {
    const { workspace } = await writeMarker(root);
    expect(workspace.marker.project).toBe(root.split('/').pop());
  });

  /**
   * 🔴 Initialising must be safe to run twice, and "safe" means it does not rewrite. `project` is
   * free text a person may have edited; silently replacing it would make initialisation a
   * destructive command that looks harmless.
   */
  it('is idempotent, and does not overwrite an edited project name', async () => {
    putMarker(
      JSON.stringify({ version: MARKER_VERSION, project: 'renamed-by-hand' }),
    );
    const { created, workspace } = await writeMarker(root, 'something-else');
    expect(created).toBe(false);
    expect(workspace.marker.project).toBe('renamed-by-hand');
  });

  it('refuses to write over a damaged marker rather than repairing it silently', async () => {
    putMarker('{ not json');
    await expect(writeMarker(root)).rejects.toThrow(WorkspaceError);
  });

  it('reports a file named like the marker directory as a WorkspaceError, and leaves it alone', async () => {
    writeFileSync(join(root, DIRECTORY), 'an unrelated config file');

    const failure = await writeMarker(root, 'demo').catch((error) => error);

    expect(failure).toBeInstanceOf(WorkspaceError);
    expect(failure.message).toContain(join(root, DIRECTORY));
    expect(readFileSync(join(root, DIRECTORY), 'utf8')).toBe(
      'an unrelated config file',
    );
  });

  it('never rewrites a marker when two initialisations race: one creates, the rest report it', async () => {
    const names = Array.from({ length: 20 }, (_, index) => `racer-${index}`);

    const results = await Promise.all(
      names.map((name) => writeMarker(root, name)),
    );

    const creators = results.filter((result) => result.created);
    expect(creators).toHaveLength(1);
    const winner = creators[0].workspace.marker.project;
    // Every caller reports the same project, and it is what is on disk.
    for (const result of results) {
      expect(result.workspace.marker.project).toBe(winner);
    }
    expect(JSON.parse(readFileSync(markerPathOf(root), 'utf8')).project).toBe(
      winner,
    );
  });

  /**
   * 🔴 A project name is a namespace for whatever the consumer keys by it, so it must be non-empty,
   * with no whitespace and no colon. A directory named `My Docs` would otherwise be marked as
   * `My Docs`, and every identifier built from it would then be refused downstream.
   */
  it.each(['My Docs', 'a:b', 'tab\there', ''])(
    'refuses %j as a project name, with its own error code',
    async (name) => {
      const failure = await writeMarker(root, name).catch((error) => error);
      expect(failure).toBeInstanceOf(WorkspaceError);
      expect((failure as WorkspaceError).code).toBe('invalid-project-name');
      await expect(readMarker(root)).resolves.toBeUndefined();
    },
  );

  /**
   * The rule is exactly "non-empty, no whitespace, no colon", and nothing more. Consumers already
   * key identifiers by names this accepts, so tightening it would break them; this pins it.
   */
  it.each(['a/b', '.', '..', 'a.b-c_d'])(
    'accepts %j as a project name: only whitespace and colons are refused',
    async (name) => {
      await expect(writeMarker(root, name)).resolves.toMatchObject({
        created: true,
        workspace: { marker: { project: name } },
      });
    },
  );
});

/**
 * 🔴 The project-name rule is checked when a marker is WRITTEN, never when one is read. A marker a
 * person edited by hand must still open; refusing it on read would turn an edit into a lost project.
 */
describe('reading does not re-check the project name', () => {
  it.each(['My Docs', ''])(
    'reads a hand-edited name %j as it is',
    async (name) => {
      putMarker(JSON.stringify({ version: MARKER_VERSION, project: name }));
      await expect(readMarker(root)).resolves.toEqual({
        root,
        marker: { version: MARKER_VERSION, project: name },
      });
    },
  );
});

describe('app state lives beneath the marker', () => {
  it('namespaces per app', () => {
    expect(appStatePathOf('/p', 'alpha')).toBe(join('/p', DIRECTORY, 'alpha'));
    expect(appStatePathOf('/p', 'beta')).toBe(join('/p', DIRECTORY, 'beta'));
  });
});

describe('WorkspaceError', () => {
  it('defaults its code to no-workspace, so a transport can report it as itself', () => {
    const error = new WorkspaceError('no project here');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('WorkspaceError');
    expect(error.code).toBe('no-workspace');
    expect(error.message).toBe('no project here');
  });
});
