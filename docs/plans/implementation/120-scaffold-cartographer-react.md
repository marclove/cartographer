# Task 120: Scaffold @cartographer/react Package

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create the `@cartographer/react` package scaffold with build tooling, peer dependencies, and the source file layout ready for hook implementation.

**Depends on:** Task 119 (@cartographer/client extracted)

**Spec Reference:** `docs/superpowers/specs/2026-03-18-react-integration-design.md` — @cartographer/react section

---

### Step 1: Create package scaffold

Create `packages/react/` with:

`packages/react/package.json`:
```json
{
  "name": "@cartographer/react",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "peerDependencies": {
    "react": ">=18",
    "@cartographer/client": ">=0.1.0"
  },
  "devDependencies": {
    "react": "^19.0.0",
    "@types/react": "^19.0.0",
    "@cartographer/client": "workspace:*"
  },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit"
  }
}
```

`packages/react/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "declaration": true,
    "jsx": "react-jsx"
  },
  "include": ["src"]
}
```

### Step 2: Create source file stubs

Create placeholder files that establish the module structure:

- `packages/react/src/index.ts` — re-exports everything
- `packages/react/src/store.ts` — SyncStore (task 121)
- `packages/react/src/provider.tsx` — CartographerProvider (task 122)
- `packages/react/src/hooks.ts` — all hooks (tasks 123–126)
- `packages/react/src/types.ts` — TreeStatusInfo and other React-specific types

`packages/react/src/types.ts`:
```ts
export interface TreeStatusInfo {
  status: string;
  durationMs: number;
  localTickCount: number;
}

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';
```

`packages/react/src/index.ts`:
```ts
export { CartographerProvider } from './provider.js';
export type { TreeStatusInfo, ConnectionStatus } from './types.js';
// Hooks will be exported as they're implemented in subsequent tasks
```

### Step 3: Install dependencies and verify

Run:
- `npm install`
- `npm run typecheck --workspace=packages/react`
- `npm run build --workspace=packages/react`

### Step 4: Commit

```bash
git add packages/react/
git commit -m "chore: scaffold @cartographer/react package"
```
