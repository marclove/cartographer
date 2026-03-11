# Decorators

Decorators wrap a single child node and modify its behavior. Every decorator extends a common base configuration:

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
|---------------|------------------|
| SUCCESS       | FAILURE          |
| FAILURE       | SUCCESS          |
| RUNNING       | RUNNING          |

**Builder:**

```typescript
builder.inverter('not-busy', (b) => {
  b.condition('is-busy', (ctx) => ctx.blackboard.get('busy') === true);
});
```

---

## RepeatNode

Repeats child execution a fixed number of times or until a target status is reached.

**Config:**

```typescript
interface RepeatConfig extends DecoratorConfig {
  count?: number;            // Max iterations (default: Infinity)
  untilStatus?: NodeStatus;  // Stop early when child returns this status
}
```

**Behavior:**

- Runs the child up to `count` times (infinite if omitted).
- If the child returns `RUNNING`, immediately returns `RUNNING`.
- If `untilStatus` is set and the child returns that status, returns that status immediately.
- Otherwise returns the last child status after all iterations complete.

**Builder:**

```typescript
builder.repeat('poll-3-times', { count: 3 }, (b) => {
  b.action('check-status', checkStatus);
});

// Repeat until success
builder.repeat('until-done', { untilStatus: NodeStatus.SUCCESS }, (b) => {
  b.action('try-task', tryTask);
});
```

---

## RetryNode

Retries a failing child up to a maximum number of attempts with an optional delay between each retry.

**Config:**

```typescript
interface RetryConfig extends DecoratorConfig {
  maxAttempts: number;  // Required
  delayMs?: number;     // Delay between retries
}
```

**Behavior:**

- Runs the child up to `maxAttempts` times.
- If the child returns anything other than `FAILURE`, returns that status immediately.
- Waits `delayMs` milliseconds between attempts when set (no delay after the last attempt).
- Returns `FAILURE` if all attempts fail.

**Builder:**

```typescript
builder.retry('retry-api', { maxAttempts: 3, delayMs: 1000 }, (b) => {
  b.action('call-api', callApi);
});
```

---

## AlwaysSucceedNode

Forces `SUCCESS` regardless of the child's result.

**Config:** `DecoratorConfig` (no extra fields).

| Child returns | AlwaysSucceed returns |
|---------------|----------------------|
| SUCCESS       | SUCCESS              |
| FAILURE       | SUCCESS              |
| RUNNING       | RUNNING              |

**Builder:**

```typescript
builder.alwaysSucceed('optional-step', (b) => {
  b.action('log-analytics', logAnalytics);
});
```

---

## AlwaysFailNode

Forces `FAILURE` regardless of the child's result.

**Config:** `DecoratorConfig` (no extra fields).

| Child returns | AlwaysFail returns |
|---------------|--------------------|
| SUCCESS       | FAILURE            |
| FAILURE       | FAILURE            |
| RUNNING       | RUNNING            |

**Builder:**

```typescript
builder.alwaysFail('force-fail', (b) => {
  b.action('some-action', someAction);
});
```

---

## TimeoutNode

Aborts the child if execution exceeds a time limit.

**Config:**

```typescript
interface TimeoutConfig extends DecoratorConfig {
  timeoutMs: number;  // Required
}
```

**Behavior:**

- Races `child.tick()` against a timeout timer.
- If the child finishes first, returns the child's status and clears the timer.
- If the timeout fires first, calls `child.abort()` and returns `FAILURE`.

**Builder:**

```typescript
builder.timeout('time-limited', { timeoutMs: 5000 }, (b) => {
  b.action('slow-task', slowTask);
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
- If the condition returns `false` (or throws), returns `FAILURE` without running the child.
- If the condition returns `true`, ticks the child and returns its status.

**Builder:**

```typescript
builder.guard('auth-guard', {
  condition: (ctx) => ctx.blackboard.has('authToken'),
}, (b) => {
  b.action('protected-action', protectedAction);
});
```

---

## Common Patterns

### Retry with Timeout

Wrap a retry in a timeout to cap the total wall-clock time across all attempts:

```typescript
builder.timeout('timed-retry', { timeoutMs: 10000 }, (b) => {
  b.retry('retry-fetch', { maxAttempts: 3, delayMs: 2000 }, (b) => {
    b.action('fetch-data', fetchData);
  });
});
```

### Guard Before Agent

Gate an expensive agent call behind a budget check:

```typescript
builder.guard('check-budget', {
  condition: (ctx) => (ctx.blackboard.get<number>('spent') ?? 0) < 1.0,
}, (b) => {
  b.agent('expensive-agent', {
    prompt: 'Analyze the data',
    options: { maxBudgetUsd: 0.50 },
  });
});
```

---

## Where to go next

- [Blackboard and Events](guide-blackboard-and-events.md) -- shared state and inter-node communication.
- [Agent Integration](guide-agent-integration.md) -- connecting LLM agents to behavior tree nodes.
