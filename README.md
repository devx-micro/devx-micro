# devx-micro

An Nx workspace for shared, reusable libraries and apps, published under the `@devx-micro` npm scope.

> **Status:** empty scaffold. No package exists yet, nothing is published, and **no licence has been
> chosen**, so `package.json` says `UNLICENSED` until one is. Do not make this repository public
> before a licence and a history check are in place.

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
