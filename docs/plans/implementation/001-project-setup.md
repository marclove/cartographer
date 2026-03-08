# Task 1: Project Setup

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Initialize the TypeScript project with all dependencies, build config, and test runner.

**Architecture:** Standard TypeScript library project with vitest for testing, targeting ES2022 with ESM output.

**Tech Stack:** TypeScript, vitest, zod, yaml, cron-parser, uuid, @anthropic-ai/claude-agent-sdk

---

### Step 1: Initialize package.json

Create `package.json` at the project root:

```json
{
  "name": "cartographer",
  "version": "0.1.0",
  "description": "Agentic behavior tree framework combining deterministic BT nodes with Claude Agent SDK integration",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "license": "MIT",
  "engines": {
    "node": ">=18"
  }
}
```

### Step 2: Install dependencies

Run:
```bash
npm install zod yaml cron-parser uuid @anthropic-ai/claude-agent-sdk
npm install -D typescript vitest @types/uuid tsx
```

### Step 3: Create tsconfig.json

Create `tsconfig.json` at the project root:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "**/*.test.ts"]
}
```

### Step 4: Create vitest.config.ts

Create `vitest.config.ts` at the project root:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.test.ts'],
  },
});
```

### Step 5: Create directory structure

Run:
```bash
mkdir -p src/core src/nodes src/composites src/decorators src/strategies src/agent src/builder src/config src/scheduler
```

### Step 6: Create placeholder index.ts

Create `src/index.ts`:

```typescript
// Cartographer - Agentic Behavior Tree Framework
```

### Step 7: Verify setup

Run:
```bash
npx tsc --noEmit
npx vitest run
```

Expected: TypeScript compiles with no errors. Vitest runs with no tests found.

### Step 8: Remove .keep file and commit

```bash
rm .keep
git add -A
git commit -m "chore: initialize cartographer project with TypeScript, vitest, and dependencies"
```
