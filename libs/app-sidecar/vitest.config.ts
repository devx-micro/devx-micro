import { defineConfig } from 'vitest/config';

import {
  swcDecoratorMetadata,
  testDefaults,
  workspaceAliases,
} from '../../vitest.shared';

export default defineConfig({
  plugins: [swcDecoratorMetadata()],
  resolve: { alias: workspaceAliases() },
  test: {
    ...testDefaults('app-sidecar'),
    include: ['src/**/*.spec.ts'],
  },
});
