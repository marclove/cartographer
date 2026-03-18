import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/cartographer/src/**/*.test.ts'],
    exclude: ['packages/cartographer/src/__integration__/**'],
    coverage: {
      enabled: true,
      provider: 'v8',
      include: ['packages/cartographer/src/**/*.ts'],
      exclude: [
        'packages/cartographer/src/**/*.test.ts',
        'packages/cartographer/src/__integration__/**',
        'packages/cartographer/src/index.ts',
        'packages/cartographer/src/cli/commands/**',
        'packages/cartographer/src/cli/index.ts',
      ],
      reporter: ['text'],
    },
  },
});
