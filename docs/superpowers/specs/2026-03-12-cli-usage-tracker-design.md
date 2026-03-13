# CLI Token & Cost Usage Tracker

## Context

When running behavior trees via the CLI, agent nodes and agent strategies make Claude SDK calls that consume tokens and incur costs. The SDK's `SDKResultMessage` includes a `modelUsage` dictionary keyed by model name, providing per-model token counts and cost. This data is currently discarded — only `total_cost_usd` is extracted and emitted via events. We need to surface per-model usage so operators can see exactly where tokens and dollars are going across a tree run.

## Design

### Overview

Extend the existing `agent:response` and `agent:error` event payloads to carry `modelUsage` data, then accumulate and display it in the CLI text formatter as an end-of-run summary.

Three layers of change:
1. **Types** — add `modelUsage` to event payloads
2. **Emission points** — extract `msg.modelUsage` where result messages are already handled
3. **CLI formatter** — accumulate per-model usage and print summary after tree completion

### Layer 1: Type Changes

**File:** `src/types.ts`

Add a `ModelUsage` type and extend the event payloads:

```ts
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

Extend `TreeEvents`:
- `agent:response` — add `modelUsage?: Record<string, ModelUsage>`
- `agent:error` — add `modelUsage?: Record<string, ModelUsage>`

### Layer 2: Extract modelUsage at Emission Points

Two call sites already handle `SDKResultMessage` and emit `agent:response`/`agent:error`. Note: `modelUsage` is always present on both `SDKResultSuccess` and `SDKResultError` variants — the optional typing in the event interface exists only for backward compatibility.

**File:** `src/nodes/agent.ts` (lines 246-250, 272-278)

In `AgentNode.execute()`, the code already does `const cost = msg.total_cost_usd`. Add `modelUsage: msg.modelUsage` to both `agent:response` (success path) and `agent:error` (error path) event emissions. Both paths have access to `modelUsage` since it is present on all `SDKResultMessage` subtypes.

**File:** `src/agent/sdk-helpers.ts` (lines 257-270)

In `createStrategyMessageHandler()`, the result handler already emits `agent:response` and `agent:error` with `cost: m.total_cost_usd`. Add `modelUsage: m.modelUsage` to both.

No changes to `queryStructured()` — the existing `onMessage` callback (`createStrategyMessageHandler`) already sees the result message.

### Layer 3: CLI Accumulation & Display

**File:** `src/cli/formatter.ts`

In `createTextFormatter()`:

1. Maintain a `Map<string, ModelUsage>` that accumulates usage across all agent calls
2. Listen to `agent:response` and `agent:error` — when `modelUsage` is present, merge each model's values into the map (summing `inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`, `webSearchRequests`, `costUSD`; taking max of `contextWindow` and `maxOutputTokens`)
3. After `tree:tick`, if the status is terminal (SUCCESS or FAILURE) and the map is non-empty, print the usage summary. For RUNNING ticks (e.g., in scheduled or multi-tick trees), accumulation continues but no summary is printed until a terminal tick. The map persists across ticks so the final summary reflects total usage for the entire run.

Accumulation helper (pure function, defined in formatter.ts):

```ts
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

Display format (text mode only, after tree:tick):

```
Usage:
  claude-sonnet-4-20250514
    Input:   12,450 tokens (cache read: 8,200, cache write: 1,100)
    Output:   3,280 tokens
    Cost:    $0.0342
  claude-haiku-4-5-20251001
    Input:    2,100 tokens
    Output:     840 tokens
    Cost:    $0.0021
  Total: $0.0363
```

Rules:
- Cache details shown in parentheses only when non-zero
- Web search requests shown only when non-zero
- `contextWindow` and `maxOutputTokens` not displayed (informational metadata, not usage)
- Numbers formatted with locale-appropriate thousands separators
- Cost formatted to 4 decimal places with `$` prefix
- If no agent calls were made (empty map), no usage section printed

**JSON mode:** The JSON formatter explicitly destructures event fields (it does not spread the full payload), so `modelUsage` must be explicitly added to the `agent:response` and `agent:error` handlers in `createJsonFormatter()`. Add `modelUsage` to the `write()` calls at lines 80-82 and 84-86. No separate usage summary event needed — consumers can aggregate from the NDJSON stream.

**Quiet mode:** No usage output.

### Files Modified

| File | Change |
|------|--------|
| `src/types.ts` | Add `ModelUsage` interface, extend `agent:response` and `agent:error` event types |
| `src/nodes/agent.ts` | Add `modelUsage: msg.modelUsage` to two event emissions |
| `src/agent/sdk-helpers.ts` | Add `modelUsage: m.modelUsage` to two event emissions in `createStrategyMessageHandler` |
| `src/cli/formatter.ts` | Add accumulation map, merge helper, display function, event listeners |

### What This Does NOT Change

- `queryStructured()` — untouched
- Agent strategy classes — untouched (they use `createStrategyMessageHandler` which handles emission)
- `BehaviorTree`, `TreeContext`, blackboard — no framework-level tracking
- CLI `run.ts` command — no changes needed (formatter handles everything)

## Verification

1. **Unit tests** — test `mergeModelUsage` with overlapping and disjoint model entries
2. **Formatter tests** — verify text output includes usage summary when `agent:response` events carry `modelUsage`; verify no summary when no agent calls occur
3. **JSON mode test** — verify `modelUsage` appears in NDJSON `agent:response` entries
4. **Manual test** — run a tree with an AgentNode against the live API, confirm usage summary prints with correct model names and token counts
