import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  test: {
    globals: true,
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/cartographer/src/**/*.test.ts'],
          exclude: ['packages/cartographer/src/__integration__/**'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['packages/cartographer/src/__integration__/**/*.test.ts'],
          exclude: ['packages/cartographer/src/__integration__/live/**'],
        },
      },
      {
        test: {
          name: 'live',
          include: ['packages/cartographer/src/__integration__/live/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'react',
          include: ['packages/react/src/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
          globals: true,
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
