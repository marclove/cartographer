# Error Handling and Resilience

This guide covers how errors propagate through behavior trees, how to build fault-tolerant trees using composable recovery patterns, and how to cancel in-progress work with abort signals.

---

## Error Containment

Every node in Cartographer extends `BaseNode`, which wraps every `execute()` call in a try/catch. If a node throws an exception, the tree does not crash. Instead:

1. The error is caught by `BaseNode.tick()`.
2. A `node:error` event is emitted with the exception.
3. A `node:exit` event is emitted with `FAILURE` status.
4. The node returns `FAILURE` to its parent.

```typescript
import { ActionNode, BehaviorTree, NodeStatus } from 'cartographer';

const risky = new ActionNode({
  name: 'might-throw',
  action: () => {
    throw new Error('something went wrong');
  },
});

const tree = new BehaviorTree({ name: 'safe-tree', root: risky });

// Listen for errors without crashing
tree.events.on('node:error', ({ node, error }) => {
  console.error(`${node.name} failed:`, error.message);
});

const status = await tree.tick();
// status === NodeStatus.FAILURE — the tree did not crash
```

This containment means that a single misbehaving node never takes down the entire tree. Parent composites see `FAILURE` and can react accordingly — a `SelectorNode` will try the next child, a `SequenceNode` will short-circuit.

---

## Composable Recovery Patterns

### Retry + Timeout Stacking

The most common resilience pattern stacks `RetryNode` around `TimeoutNode` to handle transient failures. The timeout caps each attempt, and the retry re-tries the whole operation.

```typescript
import {
  ActionNode, SequenceNode, RetryNode, TimeoutNode, NodeStatus,
} from 'cartographer';

let attempts = 0;

const unreliable = new ActionNode({
  name: 'api-call',
  action: async (ctx) => {
    attempts++;
    if (attempts < 3) {
      // Simulate a slow call that will be killed by the timeout
      await new Promise((r) => setTimeout(r, 200));
      return NodeStatus.SUCCESS;
    }
    // Third attempt completes quickly
    ctx.blackboard.set('result', 'done');
    return NodeStatus.SUCCESS;
  },
});

// TimeoutNode wraps the action — each attempt gets 100ms
const timeout = new TimeoutNode({
  name: 'timeout-wrapper',
  child: unreliable,
  timeoutMs: 100,
});

// RetryNode wraps the timeout — up to 3 attempts total
const retry = new RetryNode({
  name: 'retry-wrapper',
  child: timeout,
  maxAttempts: 3,
});

// Put it in a pipeline with follow-up work
const pipeline = new SequenceNode({
  name: 'pipeline',
  children: [retry, followUpAction],
});
```

**How it works:** On each attempt, the child is ticked. If the child returns `FAILURE` (e.g., the timeout fired), the retry increments its counter and tries again. If the child returns `SUCCESS` or `RUNNING`, the retry returns that status immediately.

**Stacking order matters.** `RetryNode` must be the outer decorator so it can re-attempt after `TimeoutNode` returns `FAILURE`. If you reverse them, the timeout would cap the total retry budget instead of each individual attempt.

### Retry with Delay

`RetryNode` accepts an optional `delayMs` for back-off between attempts:

```typescript
const retry = new RetryNode({
  name: 'retry-with-backoff',
  child: apiCallNode,
  maxAttempts: 5,
  delayMs: 500, // 500ms pause between failed attempts
});
```

The delay is inserted after each `FAILURE` except the last attempt. If all attempts fail, the retry returns `FAILURE` without a trailing delay.

### RetryNode and RUNNING Children

When a child returns `RUNNING`, `RetryNode` returns `RUNNING` immediately — it does not count that as a failed attempt. The attempt counter is local to a single `execute()` call, so on the next tick the retry restarts from attempt zero.

---

## Selector as Fallback

`SelectorNode` naturally implements a fallback pattern: it tries children in order and returns `SUCCESS` on the first child that succeeds. Combined with error containment, this gives you primary/secondary/tertiary recovery:

```typescript
import { SelectorNode, ActionNode, NodeStatus } from 'cartographer';

const fallback = new SelectorNode({
  name: 'get-data',
  children: [
    // Primary: fast cache lookup
    new ActionNode({
      name: 'from-cache',
      action: (ctx) => {
        const cached = ctx.blackboard.get('cache');
        if (cached) {
          ctx.blackboard.set('data', cached);
          return NodeStatus.SUCCESS;
        }
        return NodeStatus.FAILURE;
      },
    }),
    // Secondary: database query (might throw on connection error)
    new ActionNode({
      name: 'from-db',
      action: async (ctx) => {
        const row = await db.query('SELECT ...');
        ctx.blackboard.set('data', row);
        return NodeStatus.SUCCESS;
      },
    }),
    // Tertiary: return a default
    new ActionNode({
      name: 'default',
      action: (ctx) => {
        ctx.blackboard.set('data', { fallback: true });
        return NodeStatus.SUCCESS;
      },
    }),
  ],
});
```

If the database query throws, `BaseNode` converts the exception to `FAILURE`, and the selector moves on to the default child. No special error handling code is needed.

---

## Cooperative Cancellation with AbortSignal

`BehaviorTree` maintains an `AbortController`. When you call `tree.abort()`, two things happen:

1. `abort()` is called on the root node, which cascades to all descendants.
2. The `AbortController` is triggered, setting `context.signal.aborted` to `true`.

Long-running async actions should check `context.signal` to stop cooperatively:

```typescript
import { ActionNode, BehaviorTree, NodeStatus } from 'cartographer';

const tree = new BehaviorTree({
  name: 'cancellable',
  root: new ActionNode({
    name: 'long-running',
    action: async (ctx) => {
      // Poll for work, checking the abort signal each iteration
      while (!ctx.signal?.aborted) {
        const done = await doSomeWork();
        if (done) return NodeStatus.SUCCESS;
      }
      // Signal was aborted — return FAILURE
      return NodeStatus.FAILURE;
    },
  }),
});

// Start the tick, then cancel after 5 seconds
const tickPromise = tree.tick();
setTimeout(() => tree.abort(), 5000);

const status = await tickPromise;
// status === NodeStatus.FAILURE (action saw the abort signal)
```

The signal is available on the `TreeContext` as `ctx.signal`. It is an instance of the standard `AbortSignal` — you can also pass it to `fetch()` or other APIs that accept abort signals natively.

---

## Abort Propagation

When `tree.abort()` is called, the abort cascades through the entire tree:

- **Composites** (`SequenceNode`, `SelectorNode`, `ParallelNode`) call `abort()` on every child.
- **Decorators** (`RetryNode`, `TimeoutNode`, `RepeatNode`, etc.) call `abort()` on their single child.
- **Leaf nodes** (`ActionNode`, `ConditionNode`) have a no-op `abort()` by default.

This means abort reaches every node in the tree, regardless of depth:

```typescript
import { AbortTrackingNode } from './helpers.js'; // extends BaseNode, sets this.aborted = true

const parallel = new ParallelNode({
  name: 'par',
  children: [
    new AbortTrackingNode('child-1'),
    new AbortTrackingNode('child-2'),
    new AbortTrackingNode('child-3'),
  ],
});

await parallel.tick(ctx);
parallel.abort();

// All three children received the abort signal
```

### TimeoutNode Abort Semantics

`TimeoutNode` uses `Promise.race` to enforce a per-tick deadline. If the timer fires before the child completes, the timeout calls `child.abort()` and returns `FAILURE`. The deadline resets on every tick — a child that returns `RUNNING` gets a full `timeoutMs` window on each subsequent tick.

```typescript
const timeout = new TimeoutNode({
  name: 'capped',
  child: slowAction,
  timeoutMs: 5000,
});

// Tick 1: child has 5000ms to complete
// If child returns RUNNING at 3000ms, tick returns RUNNING
// Tick 2: child gets a fresh 5000ms deadline
```

---

## Lifecycle: abort() + reset()

After calling `abort()`, you must call `reset()` before ticking the tree again. This is because `abort()` triggers the `AbortController`, and `reset()` creates a fresh one:

```typescript
const tickPromise = tree.tick();

// Cancel the in-progress tick
tree.abort();
const status = await tickPromise;

// Required before next tick — clears node state and creates fresh AbortController
tree.reset();

// Now the tree can be ticked again
await tree.tick();
```

If you skip `reset()`, the tree's abort signal will still be in the aborted state, and any action checking `ctx.signal?.aborted` will see `true` immediately.

`reset()` also clears all node state: composite child-resumption indices, retry/repeat attempt counters, and agent node cached results.

---

## Scheduler Error Handling

`TreeScheduler` provides three error handling modes via the `onError` option:

### `'stop'` (default)

The scheduler stops on the first tick error:

```typescript
import { TreeScheduler } from 'cartographer';

const scheduler = new TreeScheduler({
  tree,
  schedule: { type: 'interval', delayMs: 1000 },
  onError: 'stop', // default behavior
});
```

### `'continue'`

The scheduler logs the error via a `tick:error` event and keeps ticking:

```typescript
const scheduler = new TreeScheduler({
  tree,
  schedule: { type: 'interval', delayMs: 1000 },
  onError: 'continue',
  maxRuns: 10,
});

scheduler.events.on('tick:error', ({ error, runCount }) => {
  console.error(`Tick ${runCount} failed:`, error.message);
});

await scheduler.start();
// Continues ticking even after errors, up to maxRuns
```

### Error Callback

A function that receives the error and run count, and returns `'continue'` or `'stop'`. This lets you implement conditional recovery — for example, tolerating a few errors but stopping after repeated failures:

```typescript
const scheduler = new TreeScheduler({
  tree,
  schedule: { type: 'interval', delayMs: 1000 },
  onError: (error, runCount) => {
    console.error(`Error on run ${runCount}:`, error.message);
    // Stop after 3 consecutive errors
    return runCount < 3 ? 'continue' : 'stop';
  },
});
```

When the callback returns `'stop'`, the scheduler emits a `scheduler:stop` event with `reason: 'error'`.

### Combining with stopOnStatus and maxRuns

`stopOnStatus` takes precedence over `maxRuns` when the target status is reached first:

```typescript
const scheduler = new TreeScheduler({
  tree,
  schedule: { type: 'interval', delayMs: 100 },
  maxRuns: 10,
  stopOnStatus: NodeStatus.SUCCESS,
});

await scheduler.start();
// Stops at the first SUCCESS, even if maxRuns hasn't been reached.
// scheduler.events 'scheduler:stop' reason will be 'stopOnStatus'.
```

---

## Putting It All Together

A production-grade resilient pipeline combines these patterns:

```typescript
import {
  TreeBuilder, TreeScheduler, NodeStatus,
} from 'cartographer';

const tree = new TreeBuilder('resilient-pipeline')
  .sequence('main', (b) => {
    // Guard: only proceed if enabled
    b.condition('is-enabled', (ctx) =>
      ctx.blackboard.get('enabled') === true,
    );

    // Retry + timeout around the unreliable operation
    b.retry('retry-fetch', { maxAttempts: 3, delayMs: 500 }, (b) => {
      b.timeout('timeout-fetch', { timeoutMs: 5000 }, (b) => {
        b.action('fetch-data', async (ctx) => {
          const data = await fetchFromApi();
          ctx.blackboard.set('data', data);
          return NodeStatus.SUCCESS;
        });
      });
    });

    // Fallback processing
    b.selector('process', (b) => {
      b.action('fast-path', async (ctx) => {
        const ok = await tryFastProcess(ctx.blackboard.get('data'));
        return ok ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
      });
      b.action('slow-path', async (ctx) => {
        await slowProcess(ctx.blackboard.get('data'));
        return NodeStatus.SUCCESS;
      });
    });
  })
  .build();

tree.blackboard.set('enabled', true);

// Run on a schedule with error recovery
const scheduler = new TreeScheduler({
  tree,
  schedule: { type: 'interval', delayMs: 30_000 },
  onError: 'continue',
  resetBetweenTicks: true,
});

tree.events.on('node:error', ({ node, error }) => {
  console.error(`[${node.name}]`, error.message);
});

await scheduler.start();
```

---

## Next Steps

- [Decorators](guide-decorators.md) — Full reference for RetryNode, TimeoutNode, and other decorators.
- [Scheduler](guide-scheduler.md) — Interval, cron, and one-shot scheduling.
- [Testing Behavior Trees](guide-testing.md) — How to test error handling and resilience patterns.
- [Advanced Patterns](guide-advanced-patterns.md) — Custom nodes, strategies, and multi-tick workflows.
