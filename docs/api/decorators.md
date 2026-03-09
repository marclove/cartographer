# Decorator Nodes

API reference for all seven decorator nodes. Each decorator wraps a single child node, transforming or controlling its execution.

All decorators extend `BaseNode`. All provide `reset()` and `abort()` methods that delegate to the child.

---

## InverterNode

```typescript
import { InverterNode } from 'cartographer';
```

**Constructor:** `new InverterNode(config: DecoratorConfig)`

**DecoratorConfig:**

| Field   | Type        | Required |
|---------|-------------|----------|
| `name`  | `string`    | Yes      |
| `child` | `BTreeNode` | Yes      |

**Status mapping:**

| Child   | Output  |
|---------|---------|
| SUCCESS | FAILURE |
| FAILURE | SUCCESS |
| RUNNING | RUNNING |

---

## RepeatNode

```typescript
import { RepeatNode } from 'cartographer';
```

**Constructor:** `new RepeatNode(config: RepeatConfig)`

**RepeatConfig:**

| Field         | Type         | Required | Default    |
|---------------|--------------|----------|------------|
| `name`        | `string`     | Yes      | --         |
| `child`       | `BTreeNode`  | Yes      | --         |
| `count`       | `number`     | No       | `Infinity` |
| `untilStatus` | `NodeStatus` | No       | --         |

**Behavior:** Runs the child up to `count` times. Returns RUNNING immediately if the child returns RUNNING. If `untilStatus` is set and the child matches that status, returns the matching status early. Otherwise returns the last child status after all iterations complete.

---

## RetryNode

```typescript
import { RetryNode } from 'cartographer';
```

**Constructor:** `new RetryNode(config: RetryConfig)`

**RetryConfig:**

| Field         | Type        | Required | Default |
|---------------|-------------|----------|---------|
| `name`        | `string`    | Yes      | --      |
| `child`       | `BTreeNode` | Yes      | --      |
| `maxAttempts` | `number`    | Yes      | --      |
| `delayMs`     | `number`    | No       | --      |

**Behavior:** Runs the child up to `maxAttempts` times. If the child returns a non-FAILURE status, returns that status immediately. When `delayMs` is specified, waits that duration between attempts (but not after the last attempt). Returns FAILURE if all attempts fail.

---

## AlwaysSucceedNode

```typescript
import { AlwaysSucceedNode } from 'cartographer';
```

**Constructor:** `new AlwaysSucceedNode(config: DecoratorConfig)`

**DecoratorConfig:**

| Field   | Type        | Required |
|---------|-------------|----------|
| `name`  | `string`    | Yes      |
| `child` | `BTreeNode` | Yes      |

**Status mapping:**

| Child   | Output  |
|---------|---------|
| SUCCESS | SUCCESS |
| FAILURE | SUCCESS |
| RUNNING | RUNNING |

---

## AlwaysFailNode

```typescript
import { AlwaysFailNode } from 'cartographer';
```

**Constructor:** `new AlwaysFailNode(config: DecoratorConfig)`

**DecoratorConfig:**

| Field   | Type        | Required |
|---------|-------------|----------|
| `name`  | `string`    | Yes      |
| `child` | `BTreeNode` | Yes      |

**Status mapping:**

| Child   | Output  |
|---------|---------|
| SUCCESS | FAILURE |
| FAILURE | FAILURE |
| RUNNING | RUNNING |

---

## TimeoutNode

```typescript
import { TimeoutNode } from 'cartographer';
```

**Constructor:** `new TimeoutNode(config: TimeoutConfig)`

**TimeoutConfig:**

| Field       | Type        | Required |
|-------------|-------------|----------|
| `name`      | `string`    | Yes      |
| `child`     | `BTreeNode` | Yes      |
| `timeoutMs` | `number`    | Yes      |

**Behavior:** Races the child tick against a timeout. If the child finishes first, returns its status. If the timeout fires first, calls `child.abort()` and returns FAILURE.

---

## GuardNode

```typescript
import { GuardNode } from 'cartographer';
```

**Constructor:** `new GuardNode(config: GuardConfig)`

**GuardConfig:**

| Field       | Type                                                      | Required |
|-------------|-----------------------------------------------------------|----------|
| `name`      | `string`                                                  | Yes      |
| `child`     | `BTreeNode`                                               | Yes      |
| `condition` | `(context: TreeContext) => Promise<boolean> \| boolean`    | Yes      |

**Behavior:** Evaluates the condition before ticking the child. If the condition returns false or throws, returns FAILURE without ticking the child. If the condition returns true, ticks the child and returns its status.
