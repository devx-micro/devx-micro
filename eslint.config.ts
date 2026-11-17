import nx from '@nx/eslint-plugin';

export default [
  ...nx.configs['flat/base'],
  ...nx.configs['flat/typescript'],
  ...nx.configs['flat/javascript'],
  {
    // Build output, not source. Flat config does not read `.gitignore`, so keep this in step with
    // the directories the repository's ignore rules create.
    ignores: ['**/dist', '**/out', '**/out-tsc', '**/coverage', '**/tmp'],
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: ['^.*/eslint(\\.base)?\\.config\\.[cm]?[jt]s$'],
          depConstraints: [
            // Scope tags: cross-bounded-context isolation
            {
              sourceTag: 'scope:shared',
              onlyDependOnLibsWithTags: ['scope:shared'],
            },
            // Type tags: layer isolation (dependency rule — inward only)
            {
              sourceTag: 'type:domain',
              onlyDependOnLibsWithTags: ['type:domain', 'type:util'],
            },
            {
              sourceTag: 'type:application',
              onlyDependOnLibsWithTags: [
                'type:domain',
                'type:application',
                'type:util',
              ],
            },
            {
              sourceTag: 'type:infrastructure',
              onlyDependOnLibsWithTags: [
                'type:domain',
                'type:application',
                'type:infrastructure',
                'type:util',
              ],
            },
            {
              sourceTag: 'type:feature',
              onlyDependOnLibsWithTags: [
                'type:domain',
                'type:application',
                'type:feature',
                'type:ui',
                'type:util',
              ],
            },
            {
              sourceTag: 'type:ui',
              onlyDependOnLibsWithTags: ['type:ui', 'type:util'],
            },
            { sourceTag: 'type:util', onlyDependOnLibsWithTags: ['type:util'] },
            { sourceTag: 'type:app', onlyDependOnLibsWithTags: ['*'] },
          ],
        },
      ],
    },
  },
  {
    // Workspace config files are not project source: each `vitest.config.ts` imports the shared
    // `vitest.shared.ts` from the repository root, which the boundaries rule reads as reaching
    // outside the project. A pattern rather than exact names, so new config files are covered.
    files: ['**/vitest.*.ts', '**/eslint.config.ts', '**/*.config.mts'],
    rules: { '@nx/enforce-module-boundaries': 'off' },
  },
];
