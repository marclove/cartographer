# Task 156: BehaviorTree Session Lifecycle

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `SessionRegistry` to `BehaviorTree` — create it, pass it through `TreeContext`, reset on terminal status, accept restored registries from `TreeActor`.

**Depends on:** Task 154 (SessionRegistry)

**Spec Reference:** `docs/superpowers/specs/2026-03-23-agent-sessions-design.md` — Tree Lifecycle section

---

### Step 1: Write failing tests

Add a new `describe('sessions', ...)` block in `src/core/behavior-tree.test.ts`:

```ts
import { SessionRegistry } from './session-registry.js';

describe('sessions', () => {
  it('provides a SessionRegistry in TreeContext', async () => {
    let capturedSessions: SessionRegistry | undefined;
    const root = new ActionNode({
      name: 'capture',
      action: async (context) => {
        capturedSessions = context.sessions;
        return NodeStatus.SUCCESS;
      },
    });
    const tree = new BehaviorTree({ name: 'test', root });
    await tree.tick();
    expect(capturedSessions).toBeInstanceOf(SessionRegistry);
  });

  it('resets the session registry on SUCCESS', async () => {
    const root = new ActionNode({
      name: 'succeed',
      action: async (context) => {
        context.sessions.set('triage', 'id-1');
        return NodeStatus.SUCCESS;
      },
    });
    const tree = new BehaviorTree({ name: 'test', root });
    await tree.tick();
    // After terminal status, registry should be cleared
    expect(tree.sessionRegistry.has('triage')).toBe(false);
  });

  it('resets the session registry on FAILURE', async () => {
    const root = new ActionNode({
      name: 'fail',
      action: async (context) => {
        context.sessions.set('triage', 'id-1');
        return NodeStatus.FAILURE;
      },
    });
    const tree = new BehaviorTree({ name: 'test', root });
    await tree.tick();
    expect(tree.sessionRegistry.has('triage')).toBe(false);
  });

  it('preserves the session registry on RUNNING', async () => {
    let callCount = 0;
    const root = new ActionNode({
      name: 'run-then-succeed',
      action: async (context) => {
        if (callCount === 0) {
          context.sessions.set('triage', 'id-1');
          callCount++;
          return NodeStatus.RUNNING;
        }
        return NodeStatus.SUCCESS;
      },
    });
    const tree = new BehaviorTree({ name: 'test', root });

    await tree.tick(); // RUNNING — sessions preserved
    expect(tree.sessionRegistry.has('triage')).toBe(true);
    expect(tree.sessionRegistry.get('triage')).toBe('id-1');

    await tree.tick(); // SUCCESS — sessions cleared
    expect(tree.sessionRegistry.has('triage')).toBe(false);
  });

  it('accepts a pre-built SessionRegistry via config', async () => {
    const registry = SessionRegistry.fromRecord({ restored: 'session-id' });
    const root = new ActionNode({
      name: 'check',
      action: async (context) => {
        expect(context.sessions.get('restored')).toBe('session-id');
        return NodeStatus.SUCCESS;
      },
    });
    const tree = new BehaviorTree({ name: 'test', root, sessionRegistry: registry });
    await tree.tick();
    expect(tree.sessionRegistry).toBe(registry);
  });
});
```

### Step 2: Run tests to verify they fail

Run: `pnpm --filter cartographer exec vitest run src/core/behavior-tree.test.ts`

Expected: FAIL — `sessions` does not exist on `TreeContext`, `sessionRegistry` does not exist on `BehaviorTree` or `BehaviorTreeConfig`.

### Step 3: Add sessions to TreeContext

Modify `src/types.ts`:

Add import at the top (after existing imports):

```ts
import type { SessionRegistry } from './core/session-registry.js';
```

Add `sessions` field to `TreeContext` interface (line 272, before the closing brace):

```ts
  /**
   * Named session registry for agent conversation sharing.
   * Managed by BehaviorTree — created on construction, passed to every tick,
   * reset when the tree reaches a terminal status (SUCCESS or FAILURE).
   */
  sessions: SessionRegistry;
```

Add `sessionRegistry` field to `BehaviorTreeConfig` interface (line 955, before the closing brace):

```ts
  /**
   * Pre-built session registry to use. When omitted, BehaviorTree creates
   * an empty one. Provide this when restoring a tree from persisted state
   * (e.g. in TreeActor) so that named sessions survive across process() calls.
   */
  sessionRegistry?: SessionRegistry;
```

### Step 4: Add SessionRegistry to BehaviorTree

Modify `src/core/behavior-tree.ts`:

Add import:

```ts
import { SessionRegistry } from './session-registry.js';
```

Add field after `private _scheduler` (line 71):

```ts
  /** Named session registry — maps session names to provider session IDs. */
  readonly sessionRegistry: SessionRegistry;
```

In the constructor (after line 78, `this.abortController = new AbortController();`):

```ts
    this.sessionRegistry = config.sessionRegistry ?? new SessionRegistry();
```

In `tick()`, add `sessions` to the TreeContext (line 136-140, update the context literal):

```ts
    const context: TreeContext = {
      blackboard: new ObservableBlackboard(this.blackboard, this.events),
      events: this.events,
      signal: this.abortController.signal,
      sessions: this.sessionRegistry,
    };
```

After the root tick completes (after line 144, `const durationMs = performance.now() - start;`), add session reset:

```ts
    if (status !== NodeStatus.RUNNING) {
      this.sessionRegistry.reset();
    }
```

### Step 5: Fix existing tests that create TreeContext directly

Adding `sessions: SessionRegistry` as a required field on `TreeContext` will break all test files that create context objects without it. The common pattern is a `createContext()` helper at the top of each test file:

```ts
function createContext(): TreeContext {
  return {
    blackboard: new InMemoryBlackboard(),
    events: new EventEmitter<TreeEvents>(),
  };
}
```

Run `pnpm typecheck` to get the full list of errors. For each, add the `sessions` field:

```ts
import { SessionRegistry } from '../core/session-registry.js';

function createContext(): TreeContext {
  return {
    blackboard: new InMemoryBlackboard(),
    events: new EventEmitter<TreeEvents>(),
    sessions: new SessionRegistry(),
  };
}
```

Test files known to use this pattern (based on codebase search):
- `src/nodes/action.test.ts`
- `src/nodes/agent.test.ts`
- `src/nodes/condition.test.ts`
- `src/nodes/base.test.ts`
- `src/nodes/receive.test.ts`
- `src/nodes/emit-to-client.test.ts`
- `src/nodes/interrupt.test.ts`
- `src/decorators/*.test.ts` (all decorator test files)
- `src/composites/*.test.ts` (sequence, selector, parallel, interrupt, inflight-delegation)
- `src/strategies/default-strategies.test.ts`
- `src/strategies/agent-strategies.test.ts`
- `src/core/serialization.test.ts`
- `src/__integration__/*.test.ts` (reactive-tick, running-state, tree-workflows, abort-signal)
- `src/tree-logger.test.ts`
- `src/agent/sdk-helpers.test.ts`

For tests that go through `BehaviorTree` (create a tree and call `tree.tick()`), no changes are needed — `BehaviorTree.tick()` now creates the context with `sessions` automatically.

### Step 6: Run tests to verify they pass

Run: `pnpm --filter cartographer test`

Expected: All pass.

### Step 7: Typecheck

Run: `pnpm typecheck`

### Step 8: Commit

```bash
git add packages/cartographer/src/types.ts packages/cartographer/src/core/behavior-tree.ts packages/cartographer/src/core/behavior-tree.test.ts
# Also add any test files that were updated to include sessions in TreeContext
git commit -m "feat(core): add SessionRegistry to BehaviorTree and TreeContext"
```
