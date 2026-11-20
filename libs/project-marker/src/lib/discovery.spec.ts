import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MARKER_FILENAME, MARKER_VERSION, WorkspaceError } from './marker';
import { projectMarker } from './project-marker';

const DIRECTORY = '.example';
const HINT = 'Run `example init` in the project root to create one.';
const { findWorkspace, resolveWorkspace } = projectMarker({
  directory: DIRECTORY,
  hint: HINT,
});

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'project-marker-discovery-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const mark = (dir: string, project = 'demo') => {
  mkdirSync(join(dir, DIRECTORY), { recursive: true });
  writeFileSync(
    join(dir, DIRECTORY, MARKER_FILENAME),
    JSON.stringify({ version: MARKER_VERSION, project }),
    'utf8',
  );
};

describe('walking up to the marker', () => {
  it('finds a marker in the starting directory', async () => {
    mark(root);
    await expect(findWorkspace(root)).resolves.toMatchObject({ root });
  });

  it('finds a marker several directories above', async () => {
    mark(root);
    const deep = join(root, 'a', 'b', 'c');
    mkdirSync(deep, { recursive: true });
    const found = await findWorkspace(deep);
    expect(found.root).toBe(root);
  });

  it('stops at the nearest marker, not the outermost', async () => {
    mark(root, 'outer');
    const inner = join(root, 'inner');
    mkdirSync(inner, { recursive: true });
    mark(inner, 'inner');
    const found = await findWorkspace(join(inner, 'deeper'));
    expect(found.marker.project).toBe('inner');
  });

  it('walks past a FILE that has the marker directory’s name, to the project above', async () => {
    mark(root, 'the-real-project');
    const sub = join(root, 'sub');
    mkdirSync(join(sub, 'deep'), { recursive: true });
    writeFileSync(join(sub, DIRECTORY), 'an unrelated config file\n');
    const found = await findWorkspace(join(sub, 'deep'));
    expect(found).toMatchObject({
      root,
      marker: { project: 'the-real-project' },
    });
  });

  it('starts from the current directory when no start is given', async () => {
    mark(root, 'from-cwd');
    const deep = join(root, 'a');
    mkdirSync(deep, { recursive: true });
    const previous = process.cwd();
    process.chdir(deep);
    try {
      const found = await findWorkspace();
      expect(found.marker.project).toBe('from-cwd');
    } finally {
      process.chdir(previous);
    }
  });
});

/**
 * 🔴 The assertions this package exists for.
 *
 * The usual way to find a project root is `git rev-parse --show-toplevel`, which succeeds in ANY git
 * repository, falling back to `process.cwd()`, which succeeds everywhere. Neither can answer "no".
 * An empty temp directory would not catch that: it is the **git repository that is not a marked
 * project** that such a resolver gets wrong, so that is what is asserted here.
 */
describe('a directory that is not a project fails loudly', () => {
  it('throws rather than falling back to the cwd', async () => {
    const deep = join(root, 'x', 'y');
    mkdirSync(deep, { recursive: true });
    await expect(findWorkspace(deep)).rejects.toThrow(WorkspaceError);
    await expect(findWorkspace(deep)).rejects.toThrow(
      /No project found at .* or any parent directory/,
    );
  });

  it('reports the code no-workspace', async () => {
    const failure = await findWorkspace(root).catch((error) => error);
    expect((failure as WorkspaceError).code).toBe('no-workspace');
  });

  it('names the marker it looked for', async () => {
    await expect(findWorkspace(root)).rejects.toThrow(
      `${DIRECTORY}/${MARKER_FILENAME}`,
    );
  });

  it('appends the hint, so the error says how to fix itself', async () => {
    await expect(findWorkspace(root)).rejects.toThrow(/example init/);
  });

  it('🔴 refuses a git repository that is not a marked project', async () => {
    execFileSync('git', ['init', '--quiet', root], { stdio: 'ignore' });
    // A `git rev-parse` resolver returns this directory happily; that is the defect.
    await expect(findWorkspace(root)).rejects.toThrow(
      /No project found at .* or any parent directory/,
    );
  });

  it('does not step past a damaged marker to its parent', async () => {
    mark(root, 'the-real-project');
    const inner = join(root, 'inner');
    mkdirSync(join(inner, DIRECTORY), { recursive: true });
    writeFileSync(join(inner, DIRECTORY, MARKER_FILENAME), '{ broken', 'utf8');
    // Skipping it would silently resolve to `root` and act on the WRONG project.
    await expect(findWorkspace(inner)).rejects.toThrow(/not valid JSON/);
  });

  it('creates nothing while it looks', async () => {
    const deep = join(root, 'x');
    mkdirSync(deep, { recursive: true });
    await expect(findWorkspace(deep)).rejects.toThrow(WorkspaceError);
    expect(existsSync(join(deep, DIRECTORY))).toBe(false);
    expect(existsSync(join(root, DIRECTORY))).toBe(false);
  });
});

describe('the override is trusted', () => {
  it('honours an override that names an unmarked directory', async () => {
    const resolved = await resolveWorkspace({ override: root });
    expect(resolved.root).toBe(root);
    expect(resolved.marker).toEqual({
      version: MARKER_VERSION,
      project: 'override',
    });
  });

  it('prefers the real marker when the override names a marked directory', async () => {
    mark(root, 'named');
    const resolved = await resolveWorkspace({ override: root });
    expect(resolved.marker.project).toBe('named');
  });

  it('still refuses a damaged marker in the overriding directory', async () => {
    mkdirSync(join(root, DIRECTORY), { recursive: true });
    writeFileSync(join(root, DIRECTORY, MARKER_FILENAME), '{ broken', 'utf8');
    await expect(resolveWorkspace({ override: root })).rejects.toThrow(
      /not valid JSON/,
    );
  });

  it('walks when no override is given', async () => {
    mark(root);
    const resolved = await resolveWorkspace({ from: root });
    expect(resolved.root).toBe(root);
  });

  it('walks when the override is empty, and fails when the walk does', async () => {
    await expect(
      resolveWorkspace({ from: root, override: '' }),
    ).rejects.toThrow(WorkspaceError);
  });
});
