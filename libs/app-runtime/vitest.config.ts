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
    ...testDefaults('app-runtime'),
    include: ['src/**/*.spec.ts'],
  },
});
