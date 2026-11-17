import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { transform } from '@swc/core';
import type { Plugin } from 'vite';

const ROOT = dirname(fileURLToPath(import.meta.url));

/**
 * `tsconfig.base.json`'s `paths`, as Vite aliases.
 *
 * 🔴 **Derived, never duplicated.** A second copy of 34 mappings is a second thing to forget, and
 * the failure mode is a test importing a *stale built* copy of a library instead of its source —
 * which looks like a passing test of the wrong code.
 */
export const workspaceAliases = (): ReadonlyArray<{
  find: string;
  replacement: string;
}> => {
  const raw = readFileSync(resolve(ROOT, 'tsconfig.base.json'), 'utf8').replace(
    /^\s*\/\/.*$/gm,
    '',
  );
  const paths: Record<string, readonly string[]> =
    JSON.parse(raw).compilerOptions?.paths ?? {};
  return Object.entries(paths).map(([find, targets]) => ({
    find,
    replacement: resolve(ROOT, targets[0] as string),
  }));
};

/**
 * SWC ahead of esbuild, for one reason: **esbuild cannot emit `design:paramtypes`.**
 *
 * 🔴 Without it Nest resolves an untokenised constructor parameter to `undefined` and reports
 * *"can't resolve dependencies of the X (?)"*, naming the consumer rather than the cause. That is
 * the same trap `graph-store` hit under tsx on 2026-08-31, and it is why this repo could not simply
 * point one runner at everything before now.
 */
export const swcDecoratorMetadata = (): Plugin => ({
  name: 'swc-decorator-metadata',
  enforce: 'pre',
  async transform(code: string, id: string) {
    if (!/\.[cm]?ts$/.test(id) || id.includes('/node_modules/')) return null;
    const output = await transform(code, {
      filename: id,
      sourceMaps: true,
      // 🔴 **Do not read `.swcrc`.** The lib builds use it to *exclude* `*.spec.ts`, so honouring it
      // here makes SWC refuse the very files this plugin exists to transform — reported as
      // "cannot process file because it's ignored by .swcrc", against a file the test run needs.
      // Everything SWC needs is supplied below.
      swcrc: false,
      configFile: false,
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        target: 'es2022',
      },
      module: { type: 'es6' },
    });
    return { code: output.code, map: output.map };
  },
});

/** Per-project coverage ratchets; empty until a project needs one. */
const RATCHET: Readonly<
  Record<string, { lines: number; statements: number; functions: number }>
> = {};

/**
 * The settings every project's suite shares. `name` is the Nx project name, and it also decides
 * where this project's coverage lands.
 *
 * 🔴 **`testTimeout` is a tightening, not a loosening.** Vitest defaults to 5s; the `node:test`
 * suites this replaces had **no timeout at all**, so a hung suite ran until CI gave up. 30s is
 * chosen to clear the slowest real case — `mvp`'s documentation suite spawns the built binary and
 * ingests 258 documents — while still failing a genuine hang in well under a minute. It went in
 * because that suite timed out at 5s on the first full run, not as a precaution.
 *
 * 🔴 **Coverage is on in CI and off locally**, keyed on `CI`, which GitLab sets. Collecting it on
 * every local run taxes the loop developers use most for a report nobody reads at that moment; not
 * collecting it in CI leaves `.gitlab-ci.yml` uploading an empty directory, which is what it did
 * until 2026-09-01 — the artifact was declared and never produced, by Jest before Vitest.
 */
export const testDefaults = (name: string) => ({
  name,
  globals: true,
  environment: 'node' as const,
  testTimeout: 30_000,
  hookTimeout: 30_000,
  coverage: {
    enabled: Boolean(process.env['CI']),
    provider: 'v8' as const,
    // 🔴 Absolute, and under the workspace root. Nx declares this project's `test` output as
    // `{workspaceRoot}/coverage/{projectRoot}` and the pipeline uploads `coverage/`; a
    // config-relative default would scatter reports into each project and match neither.
    reportsDirectory: resolve(ROOT, 'coverage', name),
    reporter: ['text-summary', 'lcov'] as const,
    // Report on what the suite could have covered, not only on files it happened to import —
    // an untested file is the thing worth seeing.
    all: true,
    include: ['src/**/*.ts'],
    // 🔴 `*.contract.ts` is **test support, not production code** — framework-agnostic assertion
    // suites (plain `node:assert`, no runner globals) exported so an application package and its
    // infrastructure package can both run the same cases against different implementations. They
    // *are* executed, by the package that owns an implementation; counting them against the package
    // that merely defines them measured the wrong thing. `workflow-engine-repository.contract.ts`
    // sat at 5% in its own project while the infrastructure project running it reported 95%.
    exclude: [
      '**/*.spec.ts',
      '**/*.spec-helper.ts',
      '**/*.test.*',
      '**/*.contract.ts',
      '**/index.ts',
      '**/*.d.ts',
      // 🔴 **Test support that ships in `src`, excluded for the same reason as `*.contract.ts`
      // above** — not to flatter the number. `read-model-fixtures.ts` builds read-model rows for
      // suites to assert against: 28 functions of arrangement, executed constantly and asserted on
      // never, which is exactly the shape that made `*.contract.ts` an exclusion. A fixture builder
      // counted as production code measures the wrong thing in the same direction.
      '**/read-model-fixtures.ts',
      // 🔴 A Playwright/e2e project's `support/` is the harness that *starts* the run — global
      // setup and teardown execute before any coverage instrumentation the project could report on,
      // so they are structurally unreachable rather than untested. `api-gateway-e2e` reported 0% of
      // 7 lines on that basis alone and failed a gate about production code.
      '**/src/support/**',
      '**/src/generated/**',
    ],
    // 🔴 **80% on lines, statements and functions — enforced, and failing today.** Founder decision
    // 2026-09-01: set the gate now and fix the red, rather than ratchet from a number nobody chose.
    //
    // Measured before it went in: 70.32% weighted overall, 21 of 39 projects at or above 80% on
    // lines. A target with work behind it, not a description of the current state.
    //
    // 🔴 **Branches are reported and not gated, deliberately.** Median branch coverage is 75%, and
    // the last 5% of it is written by covering every error path and conditional — a different and
    // much larger job than covering the code. Reporting keeps it visible; gating it would have made
    // the number the goal. Revisit once lines are genuinely at 80.
    //
    // ⚠️ It only binds where there is something to measure. A project whose sources are entirely
    // type declarations reports 100% of zero lines and passes without testing anything — `kernel`,
    // `events-domain` and `platform-shared-domain` are all in that position today.
    thresholds: RATCHET[name] ?? { lines: 80, statements: 80, functions: 80 },
  },
});
