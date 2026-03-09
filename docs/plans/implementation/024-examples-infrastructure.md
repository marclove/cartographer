# Task 24: Examples Infrastructure

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Set up the `examples/` directory infrastructure: TypeScript config for typechecking, a vitest project for verification, and npm scripts.

**Architecture:** Examples are standalone TypeScript files run with `npx tsx`. A separate `tsconfig.json` typechecks example code alongside the source it imports. A new vitest project runs example tests that require `ANTHROPIC_API_KEY`.

**Tech Stack:** TypeScript, vitest, tsx

---

### Step 1: Create examples tsconfig

Create `examples/tsconfig.json`:

```json
{
  "extends": "../tsconfig.json",
  "compilerOptions": {
    "rootDir": "..",
    "noEmit": true
  },
  "include": ["./**/*.ts", "../src/**/*.ts"],
  "exclude": ["**/*.test.ts"]
}
```

This extends the root config but overrides `rootDir` so TypeScript accepts files from both `examples/` and `src/`. Test files are excluded — vitest handles their typechecking. `noEmit` is set since examples run via `tsx`, not compiled output.

### Step 2: Update vitest config

Modify `vitest.config.ts` — add a fourth project for examples:

```typescript
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
      {
        test: {
          name: 'examples',
          include: ['examples/**/*.test.ts'],
        },
      },
    ],
  },
});
```

### Step 3: Update package.json scripts

Add `test:examples` script to `package.json`:

```json
{
  "scripts": {
    "build": "tsc",
    "test": "vitest run --project unit",
    "test:integration": "vitest run --project integration",
    "test:live": "vitest run --project live",
    "test:examples": "vitest run --project examples",
    "test:all": "vitest run",
    "test:watch": "vitest --project unit",
    "typecheck": "tsc --noEmit && tsc --noEmit -p examples/tsconfig.json"
  }
}
```

The `typecheck` script now runs both the source and examples typechecks. `test:all` already runs all projects via `vitest run` (no `--project` filter), so examples are included automatically.

### Step 4: Verify infrastructure

Run: `npm run typecheck`
Expected: PASS (examples directory has no `.ts` files yet, nothing to check)

Run: `npm run test:examples`
Expected: PASS (no test files found, vitest exits cleanly)

### Step 5: Commit

```bash
git add examples/tsconfig.json vitest.config.ts package.json
git commit -m "chore: add examples infrastructure (tsconfig, vitest project, npm scripts)"
```
