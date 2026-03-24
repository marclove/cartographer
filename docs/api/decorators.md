# Decorator Nodes

API reference for all eight decorator nodes. Each decorator wraps a single child node, transforming or controlling its execution.

All decorators extend `BaseNode`. All provide `reset()` and `abort()` methods that delegate to the child.

---

## InverterNode

```typescript
import { InverterNode } from "cartographer";
```

**Constructor:** `new InverterNode(config: DecoratorConfig)`

**DecoratorConfig:**

| Field   | Type        | Required |
| ------- | ----------- | -------- |
| `name`  | `string`    | Yes      |
| `child` | `BTreeNode` | Yes      |

**Status mapping:**

| Child   | Output  |
| ------- | ------- |
| SUCCESS | FAILURE |
| FAILURE | SUCCESS |
| RUNNING | RUNNING |

---

## RepeatNode

```typescript
import { RepeatNode } from "cartographer";
```

**Constructor:** `new RepeatNode(config: RepeatConfig)`

**RepeatConfig:**

| Field         | Type         | Required | Default    |
| ------------- | ------------ | -------- | ---------- |
| `name`        | `string`     | Yes      | --         |
| `child`       | `BTreeNode`  | Yes      | --         |
| `count`       | `number`     | No       | `Infinity` |
| `untilStatus` | `NodeStatus` | No       | --         |

**Behavior:** Runs the child up to `count` times. Returns RUNNING immediately if the child returns RUNNING; the iteration counter persists across ticks so the loop resumes at the same position. If `untilStatus` is set and the child matches that status, returns the matching status early. Otherwise returns the last child status after all iterations complete.

---

## RetryNode

```typescript
import { RetryNode } from "cartographer";
```

**Constructor:** `new RetryNode(config: RetryConfig)`

**RetryConfig:**

| Field         | Type        | Required | Default |
| ------------- | ----------- | -------- | ------- |
| `name`        | `string`    | Yes      | --      |
| `child`       | `BTreeNode` | Yes      | --      |
| `maxAttempts` | `number`    | Yes      | --      |
| `delayMs`     | `number`    | No       | --      |

**Behavior:** Runs the child up to `maxAttempts` times. If the child returns a non-FAILURE status, returns that status immediately. RUNNING does not count as a failed attempt; the attempt counter persists across ticks so the retry resumes at the same attempt. When `delayMs` is specified, waits that duration between attempts (but not after the last attempt). Returns FAILURE if all attempts fail.

---

## AlwaysSucceedNode

```typescript
import { AlwaysSucceedNode } from "cartographer";
```

**Constructor:** `new AlwaysSucceedNode(config: DecoratorConfig)`

**DecoratorConfig:**

| Field   | Type        | Required |
| ------- | ----------- | -------- |
| `name`  | `string`    | Yes      |
| `child` | `BTreeNode` | Yes      |

**Status mapping:**

| Child   | Output  |
| ------- | ------- |
| SUCCESS | SUCCESS |
| FAILURE | SUCCESS |
| RUNNING | RUNNING |

---

## AlwaysFailNode

```typescript
import { AlwaysFailNode } from "cartographer";
```

**Constructor:** `new AlwaysFailNode(config: DecoratorConfig)`

**DecoratorConfig:**

| Field   | Type        | Required |
| ------- | ----------- | -------- |
| `name`  | `string`    | Yes      |
| `child` | `BTreeNode` | Yes      |

**Status mapping:**

| Child   | Output  |
| ------- | ------- |
| SUCCESS | FAILURE |
| FAILURE | FAILURE |
| RUNNING | RUNNING |

---

## TimeoutNode

```typescript
import { TimeoutNode } from "cartographer";
```

**Constructor:** `new TimeoutNode(config: TimeoutConfig)`

**TimeoutConfig:**

| Field       | Type        | Required |
| ----------- | ----------- | -------- |
| `name`      | `string`    | Yes      |
| `child`     | `BTreeNode` | Yes      |
| `timeoutMs` | `number`    | Yes      |

**Behavior:** Tracks wall-clock time across ticks. The timer starts when the child first returns RUNNING. A background `setTimeout` fires when the deadline passes, proactively aborting the child. On the next tick after timeout, returns FAILURE without re-ticking the child. A fresh timeout window begins on each new activation cycle (after the child completes or on `reset()`/`abort()`).

---

## GuardNode

```typescript
import { GuardNode } from "cartographer";
```

**Constructor:** `new GuardNode(config: GuardConfig)`

**GuardConfig:**

| Field       | Type                                                    | Required |
| ----------- | ------------------------------------------------------- | -------- |
| `name`      | `string`                                                | Yes      |
| `child`     | `BTreeNode`                                             | Yes      |
| `condition` | `(context: TreeContext) => Promise<boolean> \| boolean` | Yes      |

**Behavior:** Evaluates the condition before ticking the child. If the condition returns false or throws, calls `child.abort()` (to clear any in-flight state) and returns FAILURE. If the condition returns true, ticks the child and returns its status. Once the child returns a terminal status (SUCCESS or FAILURE), that result is cached — subsequent ticks where the guard condition passes return the cached status without re-ticking the child. The cache is cleared on `reset()`, `abort()`, `interrupt()`, and when the guard condition evaluates to false. Async conditions use the inflight pattern (return RUNNING on first tick, poll on subsequent ticks).

---

## UntilSuccessNode

```typescript
import { untilSuccess, UntilSuccessNode } from "cartographer";
```

**Factory:** `untilSuccess(child: BTreeNode): UntilSuccessNode`

**Constructor:** `new UntilSuccessNode(config: DecoratorConfig)`

**Behavior:** Converts child FAILURE to RUNNING, creating an explicit suspension point. SUCCESS and RUNNING from the child pass through unchanged. Designed for the [application server](../guide-app-server.md) where trees suspend between messages.

| Child returns | UntilSuccess returns |
| ------------- | -------------------- |
| SUCCESS       | SUCCESS              |
| FAILURE       | RUNNING              |
| RUNNING       | RUNNING              |

Distinct from `RepeatNode` with `untilStatus: SUCCESS` — RepeatNode loops internally within a single tick and never returns RUNNING due to child failure. UntilSuccessNode returns RUNNING to the caller so the processing loop can detect the suspension.
