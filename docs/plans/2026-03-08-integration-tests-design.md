# Integration Test Expansion Design

## Goals

1. **Production confidence** — realistic multi-node workflows, error paths, and edge cases users would hit
2. **Agent SDK depth** — agentic mode, all 3 agent strategies, MCP blackboard with live agents
3. **Regression safety net** — abort/signal propagation, scheduler edge cases, RUNNING state management across complex trees

## Approach

Hybrid: one file per concern area, scenario-style tests within each file. Mocking used strategically where the SDK call isn't the subject under test. Live API tests use `model: 'haiku'`, `effort: 'low'` to keep costs down.

## File Structure

All files in `src/__integration__/`.

| File | Tests | SDK | Mock |
|------|-------|-----|------|
| `abort-signal.test.ts` | 5 | no | no |
| `scheduler-resilience.test.ts` | 5 | no | no |
| `running-state.test.ts` | 5 | no | no |
| `agent-agentic-mode.test.ts` | 4 | live (haiku/low) | no |
| `agent-strategies.test.ts` | 4 mocked + 1 live | live (haiku/low) | yes (`queryStructured`) |

24 new integration tests total. Existing files (`tree-workflows.test.ts`, `agent-sdk.test.ts`) remain untouched.

## Test Inventory

### `abort-signal.test.ts` (deterministic)

1. **Abort sequence mid-RUNNING** — sequence with 2 actions, first returns RUNNING, abort called, verify second child never ticks
2. **Abort parallel with multiple RUNNING children** — all children receive abort, verify cleanup via `AbortTrackingNode`
3. **Abort through decorators** — RetryNode(maxAttempts=5) wrapping RUNNING action, abort stops retry loop
4. **Abort with scheduler** — `scheduler.stop()` during RUNNING tick, verify `scheduler:stop` event with reason `'manual'`
5. **AbortSignal in async actions** — BehaviorTree creates AbortController, action checks `ctx.signal?.aborted`, `tree.abort()` called from setTimeout

### `scheduler-resilience.test.ts` (deterministic)

1. **`onError: 'continue'`** — tree throws on tick 1, succeeds on ticks 2-3, verify 1 error event + 2 complete events, stop reason `'maxRuns'`
2. **`onError` callback** — custom function returns `'continue'` for runCount < 3, `'stop'` at 3, verify callback args and stop reason `'error'`
3. **`maxRuns` + `stopOnStatus` interplay** — maxRuns=5, stopOnStatus=SUCCESS, tree succeeds at tick 3, verify stop reason is `'stopOnStatus'`
4. **`resetBetweenTicks` behavior** — two sub-tests verifying RUNNING state is/isn't preserved across scheduler ticks
5. **Event ordering completeness** — `{ type: 'once' }` scheduler, verify exact event sequence and data shapes

### `running-state.test.ts` (deterministic)

1. **Sequence resume skips completed children** — 3 children, middle returns RUNNING for 2 ticks, verify tick counts: A=1, B=3, C=1
2. **Selector resume with RUNNING then FAILURE fallback** — A (RUNNING, FAILURE), B (SUCCESS), verify A=2, B=1, final SUCCESS
3. **Nested composite resume** — sequence > selector > RUNNING action, verify correct resume path across 3 ticks
4. **Decorator-wrapped RUNNING** — RepeatNode(2) wrapping action with [RUNNING, SUCCESS, RUNNING, SUCCESS], 4 ticks total
5. **Parallel RUNNING with failureCount policy** — 3 actions, `failureCount: 2`, verify FAILURE when threshold met on tick 2

### `agent-agentic-mode.test.ts` (live API)

All gated by `describe.skipIf(!HAS_KEY)`, timeout 30s, haiku/low.

1. **Agentic mode with blackboard MCP tool use** — pre-seed blackboard, agent reads/writes via MCP, verify blackboard state and events
2. **Agentic mode in a tree pipeline** — TreeBuilder sequence: action writes data → agent transforms via MCP → condition checks result
3. **Agent failure mapping with `mapResult`** — structured mode, `mapResult` converts output to FAILURE, verify output still on blackboard
4. **Agent caching across ticks** — `cache: true`, tick twice, verify 1 response event, reset and tick again verifies cache cleared

### `agent-strategies.test.ts` (mocked + 1 live)

Tests 1-4 mock `queryStructured` from `../agent/sdk-helpers.js`.

1. **AgentExecutionStrategy reorders sequence children** — mock returns `['c', 'a', 'b']`, verify execution order via blackboard array
2. **AgentParallelStrategy sets policy** — mock returns `{ successCount: 1 }`, verify parallel returns SUCCESS with 1 success
3. **Strategy caching** — `cache: true`, call `order()` twice, verify mock called once
4. **Strategy reset clears cache** — `reset()` between calls, verify mock called twice
5. **(Live) AgentParallelStrategy end-to-end** — haiku/low, verify policy object returned and applied

## Helper Additions

Added to `src/__integration__/helpers.ts`:

### `AbortTrackingNode`
Extends `BaseNode`, returns a configurable status (default RUNNING), tracks whether `abort()` was called via `.aborted` flag.

### `countingAction`
Like `sequentialAction` but exposes tick count externally via `getTicks()` for assertions. Returns `{ config, getTicks }`.

## Mocking Strategy

For `agent-strategies.test.ts` tests 1-4, mock `queryStructured` from `../agent/sdk-helpers.js` using `vi.mock`. This tests whether strategy classes correctly interpret SDK responses (reordering, policy application, caching) without making API calls. The SDK integration itself is validated by the live test (test 5) and by `agent-agentic-mode.test.ts`.

## Implementation Plan

Step-by-step implementation in `docs/plans/implementation/`:

| File | Description |
|------|-------------|
| `018-test-helpers.md` | Add `AbortTrackingNode` and `countingAction` to helpers |
| `019-abort-signal-tests.md` | 5 abort/signal propagation tests |
| `020-scheduler-resilience-tests.md` | 5 scheduler error recovery tests |
| `021-running-state-tests.md` | 5 RUNNING state management tests |
| `022-agent-agentic-mode-tests.md` | 4 live API agentic mode tests |
| `023-agent-strategies-tests.md` | 4 mocked + 1 live strategy tests |
