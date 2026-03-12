# Task 36: Add onElicitation to TreeContext and BehaviorTreeConfig

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add the `onElicitation` field to `TreeContext` and `BehaviorTreeConfig`, re-export the SDK's `OnElicitation` and `ElicitationRequest` types, and wire `BehaviorTree` to set it as a context override on the root node.

**Depends on:** Task 35

---

### Step 1: Verify ElicitationResult shape

Before writing any code, confirm that the decline response `{ action: 'decline' }` is valid. Check the SDK's `ElicitationResult` type (re-exported as `ElicitResult` from `@modelcontextprotocol/sdk/types.js`).

The expected shape based on the SDK's hook types is:
```typescript
{ action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }
```

`content` is optional, so `{ action: 'decline' }` is valid. Write a quick typecheck test to confirm:

```typescript
import type { ElicitationResult } from '@anthropic-ai/claude-agent-sdk';
const result: ElicitationResult = { action: 'decline' };
```

If this fails to typecheck, investigate the actual shape and update Task 037's decline response accordingly.

### Step 2: Add types to TreeContext and BehaviorTreeConfig

Edit `src/types.ts`:

1. Update the import at the top (alongside the existing `Options` import):

```typescript
import type { Options, OnElicitation, ElicitationRequest } from '@anthropic-ai/claude-agent-sdk';
```

2. Add `onElicitation` to `TreeContext`:

```typescript
export interface TreeContext {
  blackboard: Blackboard;
  events: TypedEventEmitter<TreeEvents>;
  signal?: AbortSignal;
  /**
   * Handler for MCP elicitation requests. Inherited by descendant nodes
   * via context layering — set on a composite or the tree config and all
   * AgentNode descendants will use it unless a closer ancestor overrides it.
   */
  onElicitation?: OnElicitation;
}
```

3. Add `onElicitation` to `BehaviorTreeConfig`:

```typescript
export interface BehaviorTreeConfig {
  name: string;
  root: BTreeNode;
  blackboard?: Blackboard;
  /**
   * Default handler for MCP elicitation requests.
   * Applied as a context override on the root node, so all AgentNodes
   * in the tree inherit it unless a closer ancestor overrides it.
   */
  onElicitation?: OnElicitation;
}
```

4. Add `agent:elicitation_declined` to `TreeEvents`:

```typescript
'agent:elicitation_declined': {
  node: BTreeNode;
  request: ElicitationRequest;
};
```

### Step 3: Re-export types from index.ts

Edit `src/index.ts` to add `OnElicitation` and `ElicitationRequest` to the type re-exports:

```typescript
// SDK re-exports
export type { OnElicitation, ElicitationRequest } from '@anthropic-ai/claude-agent-sdk';
```

### Step 4: Wire BehaviorTree to set root context override

Edit `src/core/behavior-tree.ts`:

Import `BaseNode`:

```typescript
import { BaseNode } from '../nodes/base.js';
```

In the constructor, after existing setup, if `config.onElicitation` is provided, set it on the root:

```typescript
if (config.onElicitation && this.root instanceof BaseNode) {
  this.root.mergeContextOverrides({ onElicitation: config.onElicitation });
}
```

### Step 5: Write unit test for BehaviorTree constructor wiring

Add to the BehaviorTree test file (or `base.test.ts` if there's no dedicated one):

```typescript
it('sets onElicitation as contextOverrides on the root when provided in config', async () => {
  const handler = vi.fn();
  const root = new TestNode('root');
  const tree = new BehaviorTree({ name: 'test', root, onElicitation: handler });

  // Tick the tree and verify the handler is accessible in context
  let receivedContext: TreeContext | undefined;
  root.executeFn = async (ctx) => {
    receivedContext = ctx;
    return NodeStatus.SUCCESS;
  };

  await tree.tick();
  expect(receivedContext!.onElicitation).toBe(handler);
});
```

### Step 6: Run typecheck and tests

Run: `npm run typecheck && npm run test`
Expected: All pass.

### Step 7: Commit

```bash
git add src/types.ts src/index.ts src/core/behavior-tree.ts
git commit -m "feat: add onElicitation to TreeContext, BehaviorTreeConfig, and re-export SDK types"
```
