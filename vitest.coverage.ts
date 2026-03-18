import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/__integration__/**'],
    coverage: {
      enabled: true,
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/__integration__/**',
        'src/index.ts',
        'src/cli/commands/**',
        'src/cli/index.ts',
      ],
      reporter: ['text'],
    },
  },
});
