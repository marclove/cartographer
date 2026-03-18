# Task 120: Scaffold @cartographer/react Package

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create the `@cartographer/react` package scaffold with build tooling, peer dependencies, test infrastructure, and the source file layout ready for hook implementation.

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
    "@cartographer/client": "workspace:*",
    "@testing-library/react": "^16.0.0"
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

### Step 2: Set up test infrastructure

Ensure vitest config for the react package uses `environment: 'jsdom'`.

Create the mock client helper that all subsequent TDD tasks will use.

`packages/react/src/test-utils.ts`:
```ts
import type { CartographerClient } from '@cartographer/client';

/** Creates a mock CartographerClient that stores listeners and lets tests simulate SSE events. */
export function createMockClient(): CartographerClient & {
  emit(event: string, data: unknown): void;
} {
  const listeners = new Map<string, Set<(data: unknown) => void>>();

  return {
    action: vi.fn().mockResolvedValue({ id: 'msg-1' }),
    write: vi.fn().mockResolvedValue({ id: 'msg-2' }),
    send: vi.fn().mockResolvedValue({ id: 'msg-3' }),
    actionAndWait: vi.fn().mockResolvedValue({ messageId: 'msg-1', treeStatus: 'success' }),
    interrupt: vi.fn().mockResolvedValue({ interrupted: false }),
    resume: vi.fn().mockResolvedValue({ resumed: true }),
    interruptAndAction: vi.fn().mockResolvedValue({ id: 'msg-4' }),
    blackboard: vi.fn().mockResolvedValue({}),
    tree: vi.fn().mockResolvedValue({}),
    status: vi.fn().mockResolvedValue({}),
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
    },
    onAny: vi.fn(),
    off(event, handler) {
      listeners.get(event)?.delete(handler);
    },
    connect: vi.fn(),
    disconnect: vi.fn(),
    emit(event: string, data: unknown) {
      const handlers = listeners.get(event);
      if (handlers) {
        for (const handler of handlers) handler(data);
      }
    },
  };
}
```

### Step 3: Create source file stubs and types

- `packages/react/src/types.ts` — TreeStatusInfo and ConnectionStatus
- `packages/react/src/index.ts` — barrel export (populated incrementally by subsequent tasks)
- `packages/react/src/store.ts` — stub (task 121)
- `packages/react/src/provider.tsx` — stub (task 122)
- `packages/react/src/hooks.ts` — stub (tasks 123–126)

`packages/react/src/types.ts`:
```ts
export interface TreeStatusInfo {
  status: string;
  durationMs: number;
  localTickCount: number;
}

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';
```

### Step 4: Install dependencies and verify

Run:
- `npm install`
- `npm run typecheck --workspace=packages/react`
- `npm run build --workspace=packages/react`

### Step 5: Commit

```bash
git add packages/react/
git commit -m "chore: scaffold @cartographer/react package with test infrastructure"
```
