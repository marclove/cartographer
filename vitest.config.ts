import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

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
      {
        test: {
          name: 'examples',
          include: ['examples/**/*.test.ts'],
        },
      },
      {
        plugins: [svelte()],
        test: {
          name: 'dashboard',
          include: ['dashboard/src/**/*.test.ts'],
        },
      },
    ],
  },
});
