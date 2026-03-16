# Task 83: Content Hashing — Leaf Nodes

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `contentHash()` to the BTreeNode interface and implement it for BaseNode and all leaf node types (ActionNode, ConditionNode, AgentNode).

**Depends on:** None

**Spec Reference:** `docs/plans/2026-03-15-agent-enabled-application-framework.md` — Section 2 (Content Hashing)

---

### Context

The content hash is a Merkle hash computed bottom-up. Leaf nodes hash from: `hash(type, name, serializable config)`. Functions (action callbacks, condition predicates) are excluded. The hash must be deterministic: same factory output → same hashes.

Use Node's built-in `crypto.createHash('sha256')` for hashing. Return a hex string truncated to a reasonable length (e.g., first 16 characters) for readability in state maps.

### Step 1: Add contentHash to BTreeNode interface

Edit `src/types.ts`:

```ts
/** Content-based Merkle hash for serialization identity. Deterministic across factory invocations. */
contentHash(): string;
```

### Step 2: Add a hash utility

Create `src/core/content-hash.ts`:

```ts
import { createHash } from 'node:crypto';

/**
 * Compute a deterministic content hash from input parts.
 * Returns a truncated hex string (16 chars = 64 bits, sufficient for collision avoidance in small trees).
 */
export function computeContentHash(...parts: (string | string[])[]): string {
  const h = createHash('sha256');
  for (const part of parts) {
    if (Array.isArray(part)) {
      h.update(`[${part.join(',')}]`);
    } else {
      h.update(part);
    }
  }
  return h.digest('hex').slice(0, 16);
}
```

### Step 3: Implement contentHash on BaseNode

Edit `src/nodes/base.ts`:

Add a cached hash field and default implementation. The default uses the node's constructor name and its `name` property:

```ts
private _contentHash: string | null = null;

contentHash(): string {
  if (this._contentHash === null) {
    this._contentHash = this.computeHash();
  }
  return this._contentHash;
}

protected computeHash(): string {
  return computeContentHash(this.constructor.name, this.name);
}
```

### Step 4: Override computeHash on ActionNode

Edit `src/nodes/action.ts`:

ActionNode's hash includes its type and name. The action function is excluded (not content-hashable):

```ts
protected override computeHash(): string {
  return computeContentHash('ActionNode', this.name);
}
```

### Step 5: Override computeHash on ConditionNode

Edit `src/nodes/condition.ts`:

Same pattern — type + name, condition function excluded:

```ts
protected override computeHash(): string {
  return computeContentHash('ConditionNode', this.name);
}
```

### Step 6: Override computeHash on AgentNode

Edit `src/nodes/agent.ts`:

AgentNode has richer config — include type, name, model, prompt:

```ts
protected override computeHash(): string {
  return computeContentHash(
    'AgentNode',
    this.config.name,
    this.config.model ?? '',
    this.config.prompt ?? '',
  );
}
```

Check `src/nodes/agent.ts` for the actual config field names and adjust accordingly.

### Step 7: Write tests

Create `src/core/content-hash.test.ts`:

```ts
describe('computeContentHash', () => {
  it('produces deterministic output', () => {
    const a = computeContentHash('ActionNode', 'test');
    const b = computeContentHash('ActionNode', 'test');
    expect(a).toBe(b);
  });

  it('produces different hashes for different inputs', () => {
    const a = computeContentHash('ActionNode', 'foo');
    const b = computeContentHash('ActionNode', 'bar');
    expect(a).not.toBe(b);
  });

  it('returns a 16-character hex string', () => {
    const hash = computeContentHash('test');
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('node contentHash', () => {
  it('ActionNode produces stable hash across instances', () => {
    const a = new ActionNode({ name: 'test', action: async () => NodeStatus.SUCCESS });
    const b = new ActionNode({ name: 'test', action: async () => NodeStatus.FAILURE });
    expect(a.contentHash()).toBe(b.contentHash()); // same name, different function — same hash
  });

  it('ActionNode produces different hash for different names', () => {
    const a = new ActionNode({ name: 'foo', action: async () => NodeStatus.SUCCESS });
    const b = new ActionNode({ name: 'bar', action: async () => NodeStatus.SUCCESS });
    expect(a.contentHash()).not.toBe(b.contentHash());
  });

  it('AgentNode includes model and prompt in hash', () => {
    const a = new AgentNode({ name: 'agent', prompt: 'Do X' });
    const b = new AgentNode({ name: 'agent', prompt: 'Do Y' });
    expect(a.contentHash()).not.toBe(b.contentHash());
  });

  it('contentHash is cached after first call', () => {
    const node = new ActionNode({ name: 'test', action: async () => NodeStatus.SUCCESS });
    const first = node.contentHash();
    const second = node.contentHash();
    expect(first).toBe(second);
  });
});
```

### Step 8: Run tests

Run: `npx vitest run src/core/content-hash.test.ts src/nodes/`
Expected: All pass.

### Step 9: Typecheck

Run: `npm run typecheck`

### Step 10: Commit

```bash
git add src/types.ts src/core/content-hash.ts src/core/content-hash.test.ts src/nodes/base.ts src/nodes/action.ts src/nodes/condition.ts src/nodes/agent.ts
git commit -m "feat(core): add content hashing to BTreeNode interface and leaf nodes"
```
