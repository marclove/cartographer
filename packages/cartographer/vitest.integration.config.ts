import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__integration__/**/*.test.ts'],
    exclude: ['src/__integration__/live/**'],
  },
});
