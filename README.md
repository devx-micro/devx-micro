# devx-micro

An Nx workspace for shared, reusable libraries and apps, published under the `@devx-micro` npm scope.

> **Status:** early. Licensed under [MPL-2.0](LICENSE). A secrets scan of the full git history
> (`gitleaks git`) found nothing on 2026-11-17; re-run it before making this repository public.

## Layout

```
libs/   one package per directory, @devx-micro/<name>
apps/   runnable apps
```

Packages are npm workspaces, built by Nx (`npm run build`, `npm test`, `npm run typecheck`).

## Rules

- A package here depends on `@nestjs/*`, `@devx-micro/*` and third-party packages, **never** on
  anything from a consuming repository. A shared library that imports its consumer has become part of it.
- Source, specs, comments and docs carry no names, paths or hosts from any private repository.
