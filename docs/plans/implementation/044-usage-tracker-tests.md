# Task 44: Usage Tracker Tests

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add unit tests for the usage accumulation logic and formatter integration.

**Depends on:** Task 43

---

### Step 1: Test mergeModelUsage

In `src/cli/formatter.test.ts`, add tests for `mergeModelUsage`. Since it's a private function, test it indirectly through the formatter by emitting `agent:response` events with `modelUsage` and verifying the output.

Alternatively, export `mergeModelUsage` for direct testing (it's a pure function with no side effects).

Test cases:
- **Single model**: Emit one `agent:response` with modelUsage for one model, verify summary appears with correct values
- **Multiple models**: Emit responses from different models, verify per-model breakdown and total cost
- **Accumulation**: Emit two responses from the same model, verify tokens and cost are summed
- **Cache display**: Emit usage with non-zero cache values, verify parenthetical display
- **No cache**: Emit usage with zero cache values, verify no parenthetical
- **Web searches**: Emit usage with `webSearchRequests > 0`, verify line appears
- **Empty usage**: Emit no agent responses, verify no usage section printed

### Step 2: Test terminal-tick-only display

Verify that the usage summary only prints on SUCCESS and FAILURE ticks, not on RUNNING ticks:

- Emit `agent:response` with modelUsage, then emit `tree:tick` with `status: 'running'` — verify no usage printed
- Then emit `tree:tick` with `status: 'success'` — verify usage summary appears

### Step 3: Test JSON mode includes modelUsage

Emit `agent:response` event with modelUsage using the JSON formatter. Verify the NDJSON output includes the `modelUsage` field.

### Step 4: Test quiet mode excludes usage

Emit `agent:response` with modelUsage using the quiet formatter. Verify no usage summary is printed.

### Step 5: Run full test suite

Run: `npm run typecheck && npm run test`
Expected: All pass including new tests.

### Step 6: Commit all changes

```bash
git add src/types.ts src/nodes/agent.ts src/agent/sdk-helpers.ts src/cli/formatter.ts src/cli/formatter.test.ts
git commit -m "feat: add per-model token and cost usage tracking to CLI"
```
