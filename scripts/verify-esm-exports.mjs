// Proves every built package exposes its exports to a native-ESM importer.
//
// The packages are CommonJS. Node's ESM loader finds a CommonJS module's named exports by scanning
// its source, and it cannot see through every re-export helper: with swc's `_export_star`, a
// package's `index.js` looked empty to `import { SidecarClient } from '@devx-micro/app-sidecar'`
// (0.1.x and 0.2.0 shipped that way). `tsc`'s `tslib.__exportStar(...)` is recognised.
//
// Each built package is copied into a scratch `node_modules` (a copy, not a symlink, so its own
// `require`s resolve to the other copies rather than to the workspace sources), then imported both
// ways. The ESM namespace must carry every name the CommonJS exports have.
import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist', 'libs');
const scratch = join(root, 'tmp', 'verify-esm');
const scope = join(scratch, 'node_modules', '@devx-micro');

rmSync(scratch, { recursive: true, force: true });
mkdirSync(scope, { recursive: true });
const packages = readdirSync(dist);
if (packages.length === 0)
  throw new Error(`Nothing built in ${dist}; run the build first.`);
for (const name of packages)
  cpSync(join(dist, name), join(scope, name), { recursive: true });

const require = createRequire(join(scratch, 'index.js'));
let failed = false;
for (const name of packages) {
  const specifier = `@devx-micro/${name}`;
  const commonjs = Object.keys(require(specifier)).filter(
    (key) => key !== '__esModule',
  );
  const entry = require.resolve(specifier);
  const esm = await import(pathToFileURL(entry).href);
  const missing = commonjs.filter((key) => !(key in esm));
  if (commonjs.length === 0 || missing.length > 0) {
    failed = true;
    console.error(
      `✖ ${specifier}: ${commonjs.length === 0 ? 'exports nothing' : `ESM import is missing ${missing.length} of ${commonjs.length} exports (${missing.slice(0, 5).join(', ')}…)`}`,
    );
  } else {
    console.log(`✔ ${specifier}: ${commonjs.length} exports visible to ESM`);
  }
}
rmSync(scratch, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
