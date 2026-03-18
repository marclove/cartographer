import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__integration__/live/**/*.test.ts'],
  },
});
