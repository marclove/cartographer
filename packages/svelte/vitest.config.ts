import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte({ hot: false })],
  resolve: {
    conditions: ['browser'],
  },
  test: {
    include: ['src/**/*.test.{ts,svelte.ts}'],
    environment: 'jsdom',
    globals: true,
  },
});
