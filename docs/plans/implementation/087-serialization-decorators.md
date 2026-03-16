# Task 87: Serialization — Decorators

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement `serialize()` and `restore()` on decorator nodes that hold execution state (Retry, Repeat). Stateless decorators (Inverter, AlwaysSucceed, AlwaysFail, Guard, Timeout) use the BaseNode default (empty state).

**Depends on:** Tasks 83, 84, 85

**Spec Reference:** `docs/plans/2026-03-15-agent-enabled-application-framework.md` — Section 2 (Serializable Execution State)

---

### Step 1: Implement on RetryNode

Check `src/decorators/retry.ts` for the retry count field name. Serialize the current attempt count:

```ts
serialize(): NodeState {
  return { count: this.currentAttempt }; // adjust field name as needed
}

restore(state: NodeState): void {
  if (state.count !== undefined) {
    this.currentAttempt = state.count;
  }
}
```

### Step 2: Implement on RepeatNode

Check `src/decorators/repeat.ts` for the iteration count field name:

```ts
serialize(): NodeState {
  return { count: this.currentIteration }; // adjust field name as needed
}

restore(state: NodeState): void {
  if (state.count !== undefined) {
    this.currentIteration = state.count;
  }
}
```

### Step 3: Verify stateless decorators

Inverter, AlwaysSucceed, AlwaysFail, Guard, Timeout — these should use the BaseNode default (`serialize()` returns `{}`, `restore()` is a no-op). No changes needed. Verify by reading each file.

Note: TimeoutNode may have a start time or timer state. If it does, it should NOT be serialized — timers are re-established on the next tick. The `runToCompletion()` guarantee means the tree is at rest when serialized.

### Step 4: Write tests

```ts
describe('decorator serialization', () => {
  it('RetryNode serializes current attempt count', () => {
    // Create a RetryNode, simulate some retries, serialize, restore
    // Verify the count survived
  });

  it('RepeatNode serializes current iteration count', () => {
    // Same pattern
  });

  it('InverterNode serializes empty state', () => {
    const child = new ActionNode({ name: 'a', action: async () => NodeStatus.SUCCESS });
    const inv = new InverterNode({ name: 'inv', child });
    expect(inv.serialize()).toEqual({});
  });
});
```

### Step 5: Run tests

Run: `npx vitest run src/decorators/ src/core/serialization.test.ts`
Expected: All pass.

### Step 6: Commit

```bash
git add src/decorators/
git commit -m "feat(core): add serialize/restore to Retry and Repeat decorators"
```
