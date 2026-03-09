import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          exclude: ['src/__integration__/**'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['src/__integration__/**/*.test.ts'],
          exclude: ['src/__integration__/live/**'],
        },
      },
      {
        test: {
          name: 'live',
          include: ['src/__integration__/live/**/*.test.ts'],
        },
      },
    ],
  },
});
