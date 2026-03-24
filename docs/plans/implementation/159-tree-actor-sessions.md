# Task 159: TreeActor Session Serialization

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add session persistence to `TreeActor` — serialize the `SessionRegistry` when saving state, restore it when loading state, and handle backward compatibility with existing serialized states that lack a `sessions` field.

**Depends on:** Task 156 (BehaviorTree sessions)

**Spec Reference:** `docs/superpowers/specs/2026-03-23-agent-sessions-design.md` — TreeActor Serialization section

---

### Step 1: Add sessions to TreeSessionState

Modify `src/state/state-store.ts` — add `sessions` field to `TreeSessionState` (optional for backward compat):

```ts
  /**
   * Named session registry — maps session names to provider session IDs.
   * Optional for backward compatibility with existing serialized states.
   * Defaults to empty `{}` when absent.
   */
  sessions?: Record<string, string>;
```

### Step 2: Write failing tests

Add to the existing `TreeActor` test file (likely `src/actor/tree-actor.test.ts`). Look for the existing test patterns to understand how the test creates trees and state stores, then add:

```ts
describe('TreeActor - sessions', () => {
  it('serializes the session registry in saved state', async () => {
    // Create a tree where an action node writes to the session registry,
    // then returns RUNNING so the state is saved mid-run.
    const store = new InMemoryStateStore();
    const actor = new TreeActor({
      createTree: () => {
        const root = new ActionNode({
          name: 'write-session',
          action: async (context) => {
            context.sessions.set('triage', 'sdk-session-123');
            return NodeStatus.RUNNING;
          },
        });
        return new BehaviorTree({ name: 'test', root });
      },
      stateStore: store,
      stateKey: 'test-session',
    });

    await actor.process({ type: 'tick' });
    const saved = await store.getState('test-session');
    expect(saved?.sessions).toEqual({ triage: 'sdk-session-123' });
  });

  it('restores the session registry from loaded state', async () => {
    const store = new InMemoryStateStore();
    let capturedSessions: Record<string, string> = {};

    const createTree = () => {
      const root = new ActionNode({
        name: 'read-session',
        action: async (context) => {
          capturedSessions = context.sessions.toRecord();
          return NodeStatus.SUCCESS;
        },
      });
      return new BehaviorTree({ name: 'test', root });
    };

    // Pre-populate state with sessions
    const tree = createTree();
    await store.saveState('test-session', {
      blackboard: {},
      treeState: { rootHash: tree.rootHash, nodes: {} },
      sessions: { triage: 'sdk-session-123' },
      createdAt: Date.now(),
      lastMessageAt: Date.now(),
    });

    const actor = new TreeActor({
      createTree,
      stateStore: store,
      stateKey: 'test-session',
    });

    await actor.process({ type: 'tick' });
    expect(capturedSessions).toEqual({ triage: 'sdk-session-123' });
  });

  it('handles missing sessions field in stored state (backward compat)', async () => {
    const store = new InMemoryStateStore();
    let capturedSessions: Record<string, string> = {};

    const createTree = () => {
      const root = new ActionNode({
        name: 'read-session',
        action: async (context) => {
          capturedSessions = context.sessions.toRecord();
          return NodeStatus.SUCCESS;
        },
      });
      return new BehaviorTree({ name: 'test', root });
    };

    // Pre-populate state WITHOUT sessions field (old format)
    const tree = createTree();
    await store.saveState('test-session', {
      blackboard: {},
      treeState: { rootHash: tree.rootHash, nodes: {} },
      createdAt: Date.now(),
      lastMessageAt: Date.now(),
      // no sessions field
    });

    const actor = new TreeActor({
      createTree,
      stateStore: store,
      stateKey: 'test-session',
    });

    await actor.process({ type: 'tick' });
    expect(capturedSessions).toEqual({}); // empty, not error
  });

  it('clears sessions when the tree reaches terminal status', async () => {
    const store = new InMemoryStateStore();
    let tickCount = 0;

    const actor = new TreeActor({
      createTree: () => {
        const root = new ActionNode({
          name: 'session-lifecycle',
          action: async (context) => {
            tickCount++;
            if (tickCount === 1) {
              context.sessions.set('triage', 'session-id');
              return NodeStatus.RUNNING;
            }
            return NodeStatus.SUCCESS;
          },
        });
        return new BehaviorTree({ name: 'test', root });
      },
      stateStore: store,
      stateKey: 'test-session',
    });

    // First tick — RUNNING, sessions saved
    await actor.process({ type: 'tick' });
    let saved = await store.getState('test-session');
    expect(saved?.sessions).toEqual({ triage: 'session-id' });

    // Second tick — SUCCESS, sessions cleared by BehaviorTree.tick()
    await actor.process({ type: 'tick' });
    saved = await store.getState('test-session');
    expect(saved?.sessions).toEqual({});
  });
});
```

### Step 3: Run tests to verify they fail

Run: `pnpm --filter cartographer exec vitest run src/actor/tree-actor.test.ts`

Expected: FAIL — TreeActor does not serialize/restore sessions.

### Step 4: Implement session serialization in TreeActor

Modify `src/actor/tree-actor.ts`:

Add import:

```ts
import { SessionRegistry } from '../core/session-registry.js';
```

In the `process()` method, find where the tree is created and state is loaded. After restoring the blackboard and tree state, also restore the session registry.

**Approach:** Remove `readonly` from `BehaviorTree.sessionRegistry` (it's already public) so TreeActor can reassign it after construction. This is the simplest approach — no factory signature changes, no hacky casts.

In `src/core/behavior-tree.ts`, change:

```ts
readonly sessionRegistry: SessionRegistry;
```

to:

```ts
sessionRegistry: SessionRegistry;
```

Then in TreeActor.process():

```ts
    const tree = this.createTree();

    // Load state
    const stored = await this.stateStore.getState(this.stateKey);
    if (stored) {
      // existing restoration...

      // Restore session registry
      const sessions = SessionRegistry.fromRecord(stored.sessions ?? {});
      tree.sessionRegistry = sessions;
    }
```

And when saving:

```ts
    await this.stateStore.saveState(this.stateKey, {
      blackboard: ...,
      treeState: ...,
      treeStructure: ...,
      sessions: tree.sessionRegistry.toRecord(),
      createdAt: ...,
      lastMessageAt: ...,
      held: ...,
    });
```

Find the exact locations in the existing `process()` method where state is loaded and saved, and add the session registry handling there.

**Important:** TreeActor also saves state in the `handleSignal()` method (for stop/reset/abort signals). Ensure that `sessions: tree.sessionRegistry.toRecord()` is included in the `saveState` call there too, not just in the main process() save path.

### Step 5: Run tests to verify they pass

Run: `pnpm --filter cartographer exec vitest run src/actor/tree-actor.test.ts`

Expected: All pass.

### Step 6: Run full test suite

Run: `pnpm --filter cartographer test`

Expected: All pass.

### Step 7: Typecheck

Run: `pnpm typecheck`

### Step 8: Commit

```bash
git add packages/cartographer/src/state/state-store.ts packages/cartographer/src/actor/tree-actor.ts packages/cartographer/src/actor/tree-actor.test.ts packages/cartographer/src/core/behavior-tree.ts
git commit -m "feat(actor): serialize and restore session registry in TreeActor"
```
