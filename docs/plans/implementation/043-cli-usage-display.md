# Task 43: CLI Usage Accumulation and Display

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Accumulate per-model usage in the CLI formatters and display an end-of-run summary in text mode. Include `modelUsage` in JSON mode output.

**Depends on:** Task 42

---

### Step 1: Add mergeModelUsage helper to formatter.ts

Edit `src/cli/formatter.ts` — add a private helper function (import `ModelUsage` from types):

```ts
import type { TypedEventEmitter, TreeEvents, BTreeNode, ModelUsage } from '../types.js';

function mergeModelUsage(
  accumulated: Map<string, ModelUsage>,
  incoming: Record<string, ModelUsage>,
): void {
  for (const [model, usage] of Object.entries(incoming)) {
    const existing = accumulated.get(model);
    if (existing) {
      existing.inputTokens += usage.inputTokens;
      existing.outputTokens += usage.outputTokens;
      existing.cacheReadInputTokens += usage.cacheReadInputTokens;
      existing.cacheCreationInputTokens += usage.cacheCreationInputTokens;
      existing.webSearchRequests += usage.webSearchRequests;
      existing.costUSD += usage.costUSD;
      existing.contextWindow = Math.max(existing.contextWindow, usage.contextWindow);
      existing.maxOutputTokens = Math.max(existing.maxOutputTokens, usage.maxOutputTokens);
    } else {
      accumulated.set(model, { ...usage });
    }
  }
}
```

### Step 2: Add formatUsageSummary helper

Add a function that renders the usage map as text lines:

```ts
function formatUsageSummary(usage: Map<string, ModelUsage>): string[] {
  if (usage.size === 0) return [];

  const lines: string[] = ['', 'Usage:'];
  let totalCost = 0;

  for (const [model, u] of usage) {
    totalCost += u.costUSD;
    lines.push(`  ${model}`);

    // Input line with optional cache details
    const cacheParts: string[] = [];
    if (u.cacheReadInputTokens > 0) cacheParts.push(`cache read: ${fmt(u.cacheReadInputTokens)}`);
    if (u.cacheCreationInputTokens > 0) cacheParts.push(`cache write: ${fmt(u.cacheCreationInputTokens)}`);
    const cacheStr = cacheParts.length > 0 ? ` (${cacheParts.join(', ')})` : '';
    lines.push(`    Input:  ${fmt(u.inputTokens)} tokens${cacheStr}`);

    lines.push(`    Output: ${fmt(u.outputTokens)} tokens`);

    if (u.webSearchRequests > 0) {
      lines.push(`    Web searches: ${fmt(u.webSearchRequests)}`);
    }

    lines.push(`    Cost:   $${u.costUSD.toFixed(4)}`);
  }

  lines.push(`  Total: $${totalCost.toFixed(4)}`);
  return lines;
}

function fmt(n: number): string {
  return n.toLocaleString();
}
```

### Step 3: Integrate into createTextFormatter

In `createTextFormatter()`:

1. Add state: `const modelUsage = new Map<string, ModelUsage>();`

2. Add listeners for `agent:response` and `agent:error` to accumulate usage:

```ts
on('agent:response', ({ modelUsage: mu }) => {
  if (mu) mergeModelUsage(modelUsage, mu);
});

on('agent:error', ({ modelUsage: mu }) => {
  if (mu) mergeModelUsage(modelUsage, mu);
});
```

3. Modify the `tree:tick` handler to print usage on terminal ticks:

```ts
on('tree:tick', ({ tree, status, durationMs }) => {
  print('');
  print(`Tree: ${tree} — ${status.toUpperCase()} (${round(durationMs)}ms)`);
  if (status === 'success' || status === 'failure') {
    for (const line of formatUsageSummary(modelUsage)) {
      print(line);
    }
  }
});
```

### Step 4: Update createJsonFormatter

In `createJsonFormatter()`, update the `agent:response` handler to include `modelUsage`:

```ts
on('agent:response', ({ node, result, cost, modelUsage }) => {
  write({ event: 'agent:response', node: node.name, result, cost, modelUsage });
});
```

And the `agent:error` handler:

```ts
on('agent:error', ({ node, subtype, errors: errs, cost, modelUsage }) => {
  write({ event: 'agent:error', node: node.name, subtype, errors: errs, cost, modelUsage });
});
```

### Step 5: Typecheck and run existing tests

Run: `npm run typecheck && npm run test`
Expected: All pass — existing formatter tests should not break from additive changes.
