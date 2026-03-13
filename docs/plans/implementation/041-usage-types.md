# Task 41: Add ModelUsage Type and Extend Event Payloads

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add the `ModelUsage` interface to `src/types.ts` and extend the `agent:response` and `agent:error` event payloads to include `modelUsage`.

**Depends on:** None

---

### Step 1: Add ModelUsage interface

Edit `src/types.ts` — add the following interface before the `TreeEvents` interface:

```ts
/**
 * Per-model token and cost breakdown from the Claude Agent SDK.
 *
 * Returned as part of `SDKResultMessage.modelUsage`, keyed by model name.
 */
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  costUSD: number;
  contextWindow: number;
  maxOutputTokens: number;
}
```

### Step 2: Extend agent:response event type

In the `TreeEvents` interface, change:

```ts
'agent:response': { node: BTreeNode; result: unknown; cost?: number };
```

to:

```ts
'agent:response': { node: BTreeNode; result: unknown; cost?: number; modelUsage?: Record<string, ModelUsage> };
```

### Step 3: Extend agent:error event type

In the `TreeEvents` interface, change the `agent:error` type to include `modelUsage`:

```ts
'agent:error': {
  node: BTreeNode;
  subtype: string;
  errors?: string[];
  permissionDenials?: unknown;
  cost?: number;
  modelUsage?: Record<string, ModelUsage>;
};
```

### Step 4: Export ModelUsage from index.ts

Verify `ModelUsage` is re-exported from `src/index.ts` (it should be if `src/types.ts` exports are re-exported via wildcard).

### Step 5: Typecheck

Run: `npm run typecheck`
Expected: All pass — these are additive type changes.
