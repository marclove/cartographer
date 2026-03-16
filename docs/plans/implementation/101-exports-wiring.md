# Task 101: Exports + Wiring

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Export all new primitives from `src/index.ts` and verify the public API surface.

**Depends on:** All previous tasks (080–100)

**Spec Reference:** `docs/plans/2026-03-15-agent-enabled-application-framework.md` — Section 12 (What Changes)

---

### Step 1: Update src/index.ts

Add exports for all new modules:

```ts
// Actor
export { TreeActor } from './actor/tree-actor.js';
export type { ActorMessage, TickMessage, ActionMessage, WriteMessage, SignalMessage } from './actor/types.js';
export { generateMessageId } from './actor/types.js';

// State
export type { StateStore, TreeSessionState, TreeEvent } from './state/state-store.js';
export { InMemoryStateStore } from './state/in-memory-state-store.js';
export { RedisStateStore } from './state/redis-state-store.js';

// Server
export { ActorServer } from './server/actor-server.js';
export type { ActorServerOptions } from './server/actor-server.js';

// Client
export { createCartographerClient, ConflictError } from './client/index.js';
export type { CartographerClient } from './client/types.js';

// New nodes
export { untilSuccess, UntilSuccessNode } from './decorators/until-success.js';
export { actionReceived, ActionReceivedNode } from './nodes/action-received.js';
export { emitToClient, EmitToClientNode } from './nodes/emit-to-client.js';

// Serialization
export { serializeTree, restoreTree, buildHashIndex } from './core/serialization.js';
export type { SerializedTreeState, NodeState } from './core/serialization.js';
export { computeContentHash } from './core/content-hash.js';
```

### Step 2: Verify typecheck

Run: `npm run typecheck`
Expected: All pass — no missing exports, no circular dependencies.

### Step 3: Verify all tests

Run: `npm run test`
Expected: All pass.

### Step 4: Verify build

Run: `npm run build`
Expected: Compiles successfully, all exports resolve.

### Step 5: Commit

```bash
git add src/index.ts
git commit -m "feat: export all actor framework primitives from package index"
```
