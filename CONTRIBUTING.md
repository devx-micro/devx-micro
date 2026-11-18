# Contributing

## Setup

```bash
npm install
npm run build && npm test && npm run typecheck && npm run lint && npm run format:check
```

Prefer Nx for running tasks (`npx nx test <project>`, `npx nx affected -t test`) so results are
cached and dependencies are built in order.

## Rules of the workspace

- Depend only on `@nestjs/*`, `@devx-micro/*` and third-party packages, never on a consuming
  repository. Express what you need from the consumer as a port (an interface).
- Do not put names, paths or hosts from any private repository in source, specs, comments or docs.
- Every library change ships with a colocated `*.spec.ts`.
- Format with Prettier (`npm run format`).

## Documenting code

API docs are generated from TSDoc comments by [TypeDoc](https://typedoc.org).

- Every exported symbol reachable from a package's `src/index.ts` should have a `/** ... */` comment
  saying what it is for, and any non-obvious invariant (what throws, what is omitted, what is
  bounded).
- Explain **why** a rule exists when a future editor might be tempted to "simplify" it.
- Use `{@link Symbol}` for cross-references; `npm run docs:check` fails on broken links and on
  types that are referenced but not exported.
- Mark internals `@internal` so they stay out of the reference.
- Update the package `README.md` when behaviour a user would notice changes.

```bash
npm run docs        # build the site into docs/api (git-ignored)
npm run docs:check  # validate only
```

## Adding a library

Use the Nx generator (`npx nx g @nx/js:lib`), then:

1. Add `src/index.ts` as the only public entry point.
2. Add a `typedoc.json` (copy one from an existing library) and a `README.md`.
3. Add the package to `tsconfig.base.json` `paths`.
4. Fill in `package.json` `repository`, `homepage`, `bugs`, `license` and `publishConfig`, as the
   existing packages do.

## Releasing

Releases are cut with a `chore: release x.y.z` commit that bumps every package version (and the
internal `@devx-micro/*` dependency pins) together.

Before publishing, run `npm run verify:esm`. The packages are CommonJS, and it checks that each built
package's named exports are visible to a native-ESM `import`; the build must keep emitting a re-export
form Node's loader can detect (`tsc`'s `tslib.__exportStar`, not swc's `_export_star`).
