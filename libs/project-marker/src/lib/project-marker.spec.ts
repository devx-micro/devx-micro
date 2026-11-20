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

import { MARKER_FILENAME, WorkspaceError } from './marker';
import { projectMarker, type ProjectMarkerOptions } from './project-marker';

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'project-marker-binding-'));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const alpha = projectMarker({ directory: '.alpha' });
const beta = projectMarker({ directory: '.beta' });

/**
 * 🔴 The reason the directory is a parameter: two tools sharing one machine, or one repository,
 * must each find only their own marker. A lookup that accepted the other tool's marker would hand
 * it a root it never initialised.
 */
describe('each binding finds only its own marker', () => {
  it('in sibling trees, each tree is found only by its own lookup', async () => {
    const a = join(base, 'a');
    const b = join(base, 'b');
    mkdirSync(join(a, 'deep'), { recursive: true });
    mkdirSync(join(b, 'deep'), { recursive: true });
    await alpha.writeMarker(a, 'project-a');
    await beta.writeMarker(b, 'project-b');

    await expect(alpha.findWorkspace(join(a, 'deep'))).resolves.toMatchObject({
      root: a,
      marker: { project: 'project-a' },
    });
    await expect(beta.findWorkspace(join(b, 'deep'))).resolves.toMatchObject({
      root: b,
      marker: { project: 'project-b' },
    });

    await expect(alpha.findWorkspace(join(b, 'deep'))).rejects.toThrow(
      WorkspaceError,
    );
    await expect(beta.findWorkspace(join(a, 'deep'))).rejects.toThrow(
      WorkspaceError,
    );
  });

  it('in nested trees, each walk passes over the other marker to reach its own', async () => {
    const inner = join(base, 'inner');
    const deep = join(inner, 'deep');
    mkdirSync(deep, { recursive: true });
    await alpha.writeMarker(base, 'outer-alpha');
    await beta.writeMarker(inner, 'inner-beta');

    await expect(alpha.findWorkspace(deep)).resolves.toMatchObject({
      root: base,
      marker: { project: 'outer-alpha' },
    });
    await expect(beta.findWorkspace(deep)).resolves.toMatchObject({
      root: inner,
      marker: { project: 'inner-beta' },
    });
  });

  it('reads the other binding’s marker as absent, not as a project', async () => {
    await beta.writeMarker(base, 'only-beta');
    await expect(alpha.readMarker(base)).resolves.toBeUndefined();
  });

  it('writes the marker and app state under its own directory only', async () => {
    await alpha.writeMarker(base, 'demo');
    expect(existsSync(join(base, '.alpha', MARKER_FILENAME))).toBe(true);
    expect(existsSync(join(base, '.beta'))).toBe(false);
    expect(alpha.markerDirectoryOf(base)).toBe(join(base, '.alpha'));
    expect(alpha.markerPathOf(base)).toBe(
      join(base, '.alpha', MARKER_FILENAME),
    );
    expect(alpha.appStatePathOf(base, 'store')).toBe(
      join(base, '.alpha', 'store'),
    );
    expect(beta.appStatePathOf(base, 'store')).toBe(
      join(base, '.beta', 'store'),
    );
  });

  it('reports the directory it was bound to', () => {
    expect(alpha.directory).toBe('.alpha');
    expect(beta.directory).toBe('.beta');
  });
});

describe('the bound functions stand alone', () => {
  /**
   * 🔴 Callers destructure the binding once and pass the functions around, so none of them may
   * depend on `this`.
   */
  it('work after destructuring', async () => {
    const { writeMarker, readMarker, findWorkspace, resolveWorkspace } = alpha;
    await writeMarker(base, 'loose');
    await expect(readMarker(base)).resolves.toMatchObject({
      marker: { project: 'loose' },
    });
    await expect(findWorkspace(base)).resolves.toMatchObject({ root: base });
    await expect(resolveWorkspace({ from: base })).resolves.toMatchObject({
      root: base,
    });
  });
});

describe('the directory name is required and must be one plain segment', () => {
  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['the current directory', '.'],
    ['the parent directory', '..'],
    ['a path with a slash', 'a/b'],
    ['a path with a backslash', 'a\\b'],
    ['not a string', 42],
    // A NUL byte binds, then fails every lookup as a "damaged project": a programming error
    // reported far from its cause, and as the wrong kind of error.
    ['a NUL byte', '\0'],
    ['a name containing a NUL byte', 'a\0b'],
    ['whitespace only', ' '],
    ['a tab only', '\t'],
    ['trailing whitespace', '.acme '],
    ['leading whitespace', ' .acme'],
  ])('refuses %s', (_label, directory) => {
    expect(() =>
      projectMarker({ directory } as unknown as ProjectMarkerOptions),
    ).toThrow(TypeError);
  });

  it('refuses no options at all', () => {
    expect(() => (projectMarker as unknown as () => unknown)()).toThrow(
      TypeError,
    );
  });

  it('accepts an ordinary dot-directory name', () => {
    expect(projectMarker({ directory: '.acme-tool_2' }).directory).toBe(
      '.acme-tool_2',
    );
  });
});

/**
 * 🔴 An app name is the namespace that keeps two apps' state apart. A name that escapes the marker
 * directory, names the marker directory itself, or names the marker file would let an app (or a
 * migration into its path) act on something that is not its own state.
 */
describe('the app name in appStatePathOf is one plain segment', () => {
  it.each([
    ['empty', ''],
    ['the current directory', '.'],
    ['the parent directory', '..'],
    ['an escape upward', '../../etc'],
    ['a path with a slash', 'a/b'],
    ['a path with a backslash', 'a\\b'],
    ['a NUL byte', 'a\0b'],
    ['the marker file name', MARKER_FILENAME],
    ['not a string', 7],
    ['missing', undefined],
  ])('refuses %s', (_label, app) => {
    expect(() => alpha.appStatePathOf(base, app as unknown as string)).toThrow(
      TypeError,
    );
  });

  it.each(['store', 'shared-kernel', '.cache', 'v2.index'])(
    'accepts %j',
    (app) => {
      expect(alpha.appStatePathOf(base, app)).toBe(join(base, '.alpha', app));
    },
  );
});

describe('the hint', () => {
  it('is appended to the not-found error, on its own line', async () => {
    const hinted = projectMarker({
      directory: '.alpha',
      hint: 'Run `alpha init` to create one.',
    });
    const failure = await hinted.findWorkspace(base).catch((error) => error);
    expect((failure as Error).message).toMatch(
      /\.alpha\/project\.json\.\nRun `alpha init` to create one\.$/,
    );
  });

  it('is left out when not given, so the message carries no product advice', async () => {
    const failure = await alpha.findWorkspace(base).catch((error) => error);
    expect((failure as Error).message).not.toContain('\n');
    expect((failure as Error).message).toMatch(/\.alpha\/project\.json\.$/);
  });

  it('is not added to the unknown-version error, where it would not help', async () => {
    const hinted = projectMarker({
      directory: '.alpha',
      hint: 'Run `alpha init` to create one.',
    });
    await hinted.writeMarker(base, 'demo');
    writeFileSync(
      hinted.markerPathOf(base),
      JSON.stringify({ version: 99, project: 'demo' }),
    );
    const failure = await hinted.readMarker(base).catch((error) => error);
    expect((failure as Error).message).toMatch(/version 99/);
    expect((failure as Error).message).not.toMatch(/alpha init/);
  });
});
