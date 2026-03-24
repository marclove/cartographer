# Decorators

Decorators wrap a single child node and modify its behavior. Cartographer includes eight built-in decorators. Every decorator extends a common base configuration:

```typescript
interface DecoratorConfig {
  name: string;
  child: BTreeNode;
}
```

All decorators pass `RUNNING` through unchanged unless otherwise noted.

---

## InverterNode

Flips the child's terminal status.

**Config:** `DecoratorConfig` (no extra fields).

| Child returns | Inverter returns |
| ------------- | ---------------- |
| SUCCESS       | FAILURE          |
| FAILURE       | SUCCESS          |
| RUNNING       | RUNNING          |

**Builder:**

```typescript
builder.inverter("not-busy", (b) => {
  b.condition("is-busy", (ctx) => ctx.blackboard.get("busy") === true);
});
```

---

## RepeatNode

Repeats child execution a fixed number of times or until a target status is reached.

**Config:**

```typescript
interface RepeatConfig extends DecoratorConfig {
  count?: number; // Max iterations (default: Infinity)
  untilStatus?: NodeStatus; // Stop early when child returns this status
}
```

**Behavior:**

- Runs the child up to `count` times (infinite if omitted).
- If the child returns `RUNNING`, immediately returns `RUNNING`. The iteration counter persists across ticks — when the child completes on a subsequent tick, the repeat resumes at the same iteration rather than restarting from zero.
- If `untilStatus` is set and the child returns that status, returns that status immediately.
- Otherwise returns the last child status after all iterations complete.
- Counter resets on completion, `untilStatus` match, `reset()`, or `abort()`. Counter is _preserved_ on `interrupt()` — see [Interrupt Behavior](#interrupt-behavior) below.

**Builder:**

```typescript
builder.repeat("poll-3-times", { count: 3 }, (b) => {
  b.action("check-status", checkStatus);
});

// Repeat until success
builder.repeat("until-done", { untilStatus: NodeStatus.SUCCESS }, (b) => {
  b.action("try-task", tryTask);
});
```

---

## RetryNode

Retries a failing child up to a maximum number of attempts with an optional delay between each retry.

**Config:**

```typescript
interface RetryConfig extends DecoratorConfig {
  maxAttempts: number; // Required
  delayMs?: number; // Delay between retries
}
```

**Behavior:**

- Runs the child up to `maxAttempts` times.
- If the child returns anything other than `FAILURE`, returns that status immediately.
- If the child returns `RUNNING`, the retry returns `RUNNING` without counting it as a failed attempt. The attempt counter persists across ticks, so the retry resumes at the same attempt on the next tick.
- Waits `delayMs` milliseconds between attempts when set (no delay after the last attempt).
- Returns `FAILURE` if all attempts fail.

**Builder:**

```typescript
builder.retry("retry-api", { maxAttempts: 3, delayMs: 1000 }, (b) => {
  b.action("call-api", callApi);
});
```

---

## AlwaysSucceedNode

Forces `SUCCESS` regardless of the child's result.

**Config:** `DecoratorConfig` (no extra fields).

| Child returns | AlwaysSucceed returns |
| ------------- | --------------------- |
| SUCCESS       | SUCCESS               |
| FAILURE       | SUCCESS               |
| RUNNING       | RUNNING               |

**Builder:**

```typescript
builder.alwaysSucceed("optional-step", (b) => {
  b.action("log-analytics", logAnalytics);
});
```

---

## AlwaysFailNode

Forces `FAILURE` regardless of the child's result.

**Config:** `DecoratorConfig` (no extra fields).

| Child returns | AlwaysFail returns |
| ------------- | ------------------ |
| SUCCESS       | FAILURE            |
| FAILURE       | FAILURE            |
| RUNNING       | RUNNING            |

**Builder:**

```typescript
builder.alwaysFail("force-fail", (b) => {
  b.action("some-action", someAction);
});
```

---

## TimeoutNode

Aborts the child if execution exceeds a time limit.

**Config:**

```typescript
interface TimeoutConfig extends DecoratorConfig {
  timeoutMs: number; // Required
}
```

**Behavior:**

- Tracks wall-clock time across ticks rather than racing per-tick. The timer starts when the child first returns `RUNNING`.
- A background `setTimeout` fires when the deadline passes, proactively aborting the child via `child.abort()`.
- On the next tick after timeout, returns `FAILURE` without re-ticking the child.
- If the child completes before the deadline, returns its status and clears the timer.
- A fresh timeout window begins on each new activation cycle (after the child completes, or on `reset()`/`abort()`/`interrupt()`).

**Builder:**

```typescript
builder.timeout("time-limited", { timeoutMs: 5000 }, (b) => {
  b.action("slow-task", slowTask);
});
```

---

## GuardNode

Checks a condition before running the child.

**Config:**

```typescript
interface GuardConfig extends DecoratorConfig {
  condition: (context: TreeContext) => Promise<boolean> | boolean;
}
```

**Behavior:**

- Evaluates the condition first.
- If the condition returns `false` (or throws), calls `child.abort()` (to clear any in-flight state) and returns `FAILURE` without ticking the child.
- If the condition returns `true`, ticks the child and returns its status. Once the child returns a terminal status (`SUCCESS` or `FAILURE`), that result is cached — subsequent ticks where the guard condition passes return the cached status without re-ticking the child.
- The cache is cleared on `reset()`, `abort()`, `interrupt()`, and when the guard condition evaluates to `false`.
- Async conditions use the inflight pattern: the promise starts on the first tick and `RUNNING` is returned immediately. Subsequent ticks poll for the result.

**Builder:**

```typescript
builder.guard(
  "auth-guard",
  {
    condition: (ctx) => ctx.blackboard.has("authToken"),
  },
  (b) => {
    b.action("protected-action", protectedAction);
  },
);
```

---

## UntilSuccessNode

Converts child `FAILURE` to `RUNNING`, creating an explicit suspension point. `SUCCESS` and `RUNNING` pass through unchanged.

**Factory:**

```typescript
import { untilSuccess } from "cartographer";

const node = untilSuccess(childNode);
```

| Child returns | UntilSuccess returns |
| ------------- | -------------------- |
| SUCCESS       | SUCCESS              |
| FAILURE       | RUNNING              |
| RUNNING       | RUNNING              |

**When to use:**

`untilSuccess` is designed for the [application server](guide-app-server.md) where a tree processes one message at a time and suspends between messages. Wrapping a `receive` node in `untilSuccess` tells the processing loop "keep this tree alive and wait for more input."

**How it differs from RepeatNode:**

`RepeatNode` with `untilStatus: NodeStatus.SUCCESS` loops _internally_ within a single tick -- it re-ticks its child immediately after each failure and never returns `RUNNING` to the caller due to a child failure. `untilSuccess` returns `RUNNING` to the tree, which causes the `runToCompletion()` loop to detect the suspension (via `hasInflightWork() === false`) and save state.

```typescript
import { untilSuccess, receive } from "cartographer";
import { SelectorNode } from "cartographer";

// Wait for user to approve or reject
const waitForDecision = untilSuccess(
  new SelectorNode({
    name: "decision",
    children: [receive("approve"), receive("reject")],
  }),
);
```

---

## Interrupt Behavior

All decorators support `interrupt()` for soft cancellation — cancelling in-flight work without losing progress. Unlike `abort()`, interrupt preserves the decorator's own state and does not require `reset()` before the next tick. See [Interrupt: Soft Cancellation](guide-error-handling.md#interrupt-soft-cancellation) for the full explanation.

By default, decorators delegate `interrupt()` to their child via the `BaseNode` default implementation. Two decorators have explicit overrides:

- **TimeoutNode**: Clears the timer and recorded start time in addition to interrupting the child. On the next tick, a fresh timeout window starts from zero.
- **GuardNode**: Clears any pending async condition evaluation in addition to interrupting the child.

The remaining decorators (InverterNode, AlwaysSucceedNode, AlwaysFailNode, UntilSuccessNode) use the BaseNode default, which recurses `interrupt()` into the child.

### Counter preservation

`RepeatNode` and `RetryNode` preserve their counters on interrupt — this is a key behavioral difference from `abort()`:

| Decorator    | On `abort()`           | On `interrupt()`          |
| ------------ | ---------------------- | ------------------------- |
| `RepeatNode` | Counter resets to 0    | Counter preserved         |
| `RetryNode`  | Attempt counter resets | Attempt counter preserved |

This means an interrupted retry resumes at the same attempt count, and an interrupted repeat resumes at the same iteration. The interrupted child restarts fresh (its inflight state is cleared), but the decorator does not count the interruption as a failed attempt or completed iteration.

---

## Common Patterns

### Retry with Timeout

Wrap a retry in a timeout to cap the total wall-clock time across all attempts:

```typescript
builder.timeout("timed-retry", { timeoutMs: 10000 }, (b) => {
  b.retry("retry-fetch", { maxAttempts: 3, delayMs: 2000 }, (b) => {
    b.action("fetch-data", fetchData);
  });
});
```

### Guard Before Agent

Gate an expensive agent call behind a budget check:

```typescript
const expensiveAgent = new ClaudeSDKAgent({
  name: "expensive-agent",
  model: "claude-sonnet-4-6",
  maxBudgetUsd: 0.5,
});

builder.guard(
  "check-budget",
  {
    condition: (ctx) => (ctx.blackboard.get<number>("spent") ?? 0) < 1.0,
  },
  (b) => {
    b.agent("expensive-agent", {
      agent: expensiveAgent,
      prompt: "Analyze the data",
    });
  },
);
```

---

## Where to go next

- [Blackboard and Events](guide-blackboard-and-events.md) -- shared state and inter-node communication.
- [Agent Integration](guide-agent-integration.md) -- connecting LLM agents to behavior tree nodes.
