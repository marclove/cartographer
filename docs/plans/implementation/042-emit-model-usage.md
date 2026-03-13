# Task 42: Emit modelUsage from SDK Result Handlers

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extract `modelUsage` from `SDKResultMessage` at both emission points and include it in `agent:response` and `agent:error` events.

**Depends on:** Task 41

---

### Step 1: Update AgentNode.execute()

Edit `src/nodes/agent.ts` — in the `execute()` method where `msg.type === 'result'` is handled:

**Success path** (around line 246): Add `modelUsage: msg.modelUsage` to the `agent:response` emission:

```ts
context.events.emit('agent:response', {
  node: this,
  result: output,
  cost,
  modelUsage: msg.modelUsage,
});
```

**Error path** (around line 272): Add `modelUsage: msg.modelUsage` to the `agent:error` emission:

```ts
context.events.emit('agent:error', {
  node: this,
  subtype: msg.subtype,
  errors: msg.errors,
  permissionDenials: msg.permission_denials,
  cost,
  modelUsage: msg.modelUsage,
});
```

Note: `modelUsage` is always present on both `SDKResultSuccess` and `SDKResultError` subtypes per the SDK docs.

### Step 2: Update createStrategyMessageHandler()

Edit `src/agent/sdk-helpers.ts` — in `createStrategyMessageHandler()` where `m.type === 'result'` is handled:

**Success path** (around line 257): Add `modelUsage: m.modelUsage`:

```ts
events.emit('agent:response', {
  node,
  result: output,
  cost: m.total_cost_usd,
  modelUsage: m.modelUsage,
});
```

**Error path** (around line 263): Add `modelUsage: m.modelUsage`:

```ts
events.emit('agent:error', {
  node,
  subtype: m.subtype,
  errors: m.errors,
  permissionDenials: m.permission_denials,
  cost: m.total_cost_usd,
  modelUsage: m.modelUsage,
});
```

### Step 3: Typecheck and run existing tests

Run: `npm run typecheck && npm run test`
Expected: All pass — existing tests don't assert on the absence of `modelUsage`.
