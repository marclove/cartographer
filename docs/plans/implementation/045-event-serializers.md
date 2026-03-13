# Task 45: Event Serialization Types and Helpers

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create serialization functions that convert internal `TreeEvents` payloads (containing non-serializable `BTreeNode` and `TreeContext` references) into JSON-safe objects for the HTTP API.

**Depends on:** None

---

### Step 1: Write failing tests for node serialization

Create `src/server/serializers.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { serializeNodeRef, serializeTree, getNodeType } from './serializers.js';
import { ActionNode } from '../nodes/action.js';
import { ConditionNode } from '../nodes/condition.js';
import { SequenceNode } from '../composites/sequence.js';
import { SelectorNode } from '../composites/selector.js';
import { ParallelNode } from '../composites/parallel.js';
import { NodeStatus } from '../types.js';
import { InverterNode } from '../decorators/inverter.js';

const dummyAction = new ActionNode({ name: 'DoStuff', id: 'do-stuff', action: async () => NodeStatus.SUCCESS });
const dummyCondition = new ConditionNode({ name: 'IsReady', id: 'is-ready', condition: async () => true });

describe('getNodeType', () => {
  it('returns correct type for leaf nodes', () => {
    expect(getNodeType(dummyAction)).toBe('action');
    expect(getNodeType(dummyCondition)).toBe('condition');
  });

  it('returns correct type for composites', () => {
    const seq = new SequenceNode({ name: 'Seq', id: 'seq', children: [] });
    expect(getNodeType(seq)).toBe('sequence');
    const sel = new SelectorNode({ name: 'Sel', id: 'sel', children: [] });
    expect(getNodeType(sel)).toBe('selector');
    const par = new ParallelNode({ name: 'Par', id: 'par', children: [] });
    expect(getNodeType(par)).toBe('parallel');
  });

  it('returns decorator for decorator nodes', () => {
    const inv = new InverterNode({ name: 'Inv', id: 'inv', child: dummyAction });
    expect(getNodeType(inv)).toBe('decorator');
  });
});

describe('serializeNodeRef', () => {
  it('returns id, name, and type', () => {
    expect(serializeNodeRef(dummyAction)).toEqual({ id: 'do-stuff', name: 'DoStuff', type: 'action' });
  });
});

describe('serializeTree', () => {
  it('recursively serializes node hierarchy', () => {
    const child1 = new ActionNode({ name: 'A', id: 'a', action: async () => NodeStatus.SUCCESS });
    const child2 = new ConditionNode({ name: 'B', id: 'b', condition: async () => true });
    const root = new SequenceNode({ name: 'Root', id: 'root', children: [child1, child2] });

    expect(serializeTree(root)).toEqual({
      id: 'root',
      name: 'Root',
      type: 'sequence',
      children: [
        { id: 'a', name: 'A', type: 'action', children: [] },
        { id: 'b', name: 'B', type: 'condition', children: [] },
      ],
    });
  });
});
```

### Step 2: Run tests to verify they fail

Run: `npx vitest run src/server/serializers.test.ts`
Expected: FAIL — module `./serializers.js` does not exist.

### Step 3: Write failing tests for event serialization

Add to the same test file:

```ts
import { serializeEvent } from './serializers.js';

describe('serializeEvent', () => {
  it('serializes node:enter — strips BTreeNode and TreeContext, keeps serializable fields', () => {
    const result = serializeEvent('node:enter', {
      node: dummyAction,
      context: {} as any,
    });
    expect(result).toEqual({
      node: { id: 'do-stuff', name: 'DoStuff', type: 'action' },
    });
  });

  it('serializes node:exit — includes status and durationMs', () => {
    const result = serializeEvent('node:exit', {
      node: dummyAction,
      status: NodeStatus.SUCCESS,
      context: {} as any,
      durationMs: 42,
    });
    expect(result).toEqual({
      node: { id: 'do-stuff', name: 'DoStuff', type: 'action' },
      status: 'success',
      durationMs: 42,
    });
  });

  it('serializes agent:thinking — includes text', () => {
    const result = serializeEvent('agent:thinking', {
      node: dummyAction,
      thinking: 'Let me think...',
    });
    expect(result).toEqual({
      nodeId: 'do-stuff',
      text: 'Let me think...',
    });
  });

  it('serializes tree:tick — passes through directly', () => {
    const result = serializeEvent('tree:tick', {
      tree: 'MyTree',
      status: NodeStatus.SUCCESS,
      durationMs: 100,
    });
    expect(result).toEqual({
      tree: 'MyTree',
      status: 'success',
      durationMs: 100,
    });
  });

  it('serializes blackboard:write — passes through directly', () => {
    const result = serializeEvent('blackboard:write', {
      key: 'foo',
      value: 42,
      source: 'test',
    });
    expect(result).toEqual({
      key: 'foo',
      value: 42,
      source: 'test',
    });
  });
});
```

### Step 4: Implement serializers

Create `src/server/serializers.ts`:

```ts
import type { BTreeNode, TreeEvents } from '../types.js';
import { ActionNode } from '../nodes/action.js';
import { ConditionNode } from '../nodes/condition.js';
import { AgentNode } from '../nodes/agent.js';
import { SequenceNode } from '../composites/sequence.js';
import { SelectorNode } from '../composites/selector.js';
import { ParallelNode } from '../composites/parallel.js';

export interface SerializedNodeRef {
  id: string;
  name: string;
  type: string;
}

export interface SerializedTreeNode extends SerializedNodeRef {
  children: SerializedTreeNode[];
}

export function getNodeType(node: BTreeNode): string {
  if (node instanceof ActionNode) return 'action';
  if (node instanceof ConditionNode) return 'condition';
  if (node instanceof AgentNode) return 'agent';
  if (node instanceof SequenceNode) return 'sequence';
  if (node instanceof SelectorNode) return 'selector';
  if (node instanceof ParallelNode) return 'parallel';
  // All other single-child wrappers are decorators
  if (node.children.length === 1) return 'decorator';
  return 'unknown';
}

export function serializeNodeRef(node: BTreeNode): SerializedNodeRef {
  return { id: node.id, name: node.name, type: getNodeType(node) };
}

export function serializeTree(node: BTreeNode): SerializedTreeNode {
  return {
    ...serializeNodeRef(node),
    children: node.children.map(serializeTree),
  };
}

export function serializeEvent<K extends keyof TreeEvents>(
  event: K,
  data: TreeEvents[K],
): Record<string, unknown> {
  const d = data as any;

  // Events with BTreeNode + TreeContext (strip context, serialize node)
  if (event === 'node:enter') {
    return { node: serializeNodeRef(d.node) };
  }
  if (event === 'node:exit') {
    return { node: serializeNodeRef(d.node), status: d.status, durationMs: d.durationMs };
  }
  if (event === 'node:error') {
    return { node: serializeNodeRef(d.node), error: d.error.message };
  }

  // Agent events — use nodeId for brevity
  if (event === 'agent:prompt') {
    return { nodeId: d.node.id, prompt: d.prompt };
  }
  if (event === 'agent:thinking') {
    return { nodeId: d.node.id, text: d.thinking };
  }
  if (event === 'agent:text') {
    return { nodeId: d.node.id, text: d.text };
  }
  if (event === 'agent:tool_use') {
    return { nodeId: d.node.id, tool: d.tool, input: d.input };
  }
  if (event === 'agent:response') {
    return { nodeId: d.node.id, result: d.result, cost: d.cost, modelUsage: d.modelUsage };
  }
  if (event === 'agent:error') {
    return { nodeId: d.node.id, subtype: d.subtype, errors: d.errors, cost: d.cost, modelUsage: d.modelUsage };
  }
  if (event === 'agent:message') {
    return { nodeId: d.node.id, message: d.message };
  }
  if (event === 'agent:tool_progress') {
    return { nodeId: d.node.id, toolUseId: d.toolUseId, toolName: d.toolName, elapsedSeconds: d.elapsedSeconds };
  }
  if (event === 'agent:init') {
    return { nodeId: d.node.id, sessionId: d.sessionId, model: d.model, tools: d.tools, mcpServers: d.mcpServers };
  }
  if (event === 'agent:status') {
    return { nodeId: d.node.id, status: d.status };
  }
  if (event === 'agent:rate_limit') {
    return { nodeId: d.node.id, info: d.info };
  }
  if (event === 'agent:stream') {
    return { nodeId: d.node.id, event: d.event };
  }
  if (event === 'agent:elicitation_declined') {
    return { nodeId: d.node.id, request: d.request };
  }

  // Strategy events
  if (event === 'strategy:decision') {
    return { compositeId: d.composite.id, strategy: d.strategy, decision: d.decision };
  }

  // Tree lifecycle and blackboard — already serializable, pass through
  return { ...d };
}
```

### Step 5: Run tests to verify they pass

Run: `npx vitest run src/server/serializers.test.ts`
Expected: All pass.

### Step 6: Typecheck

Run: `npm run typecheck`
Expected: All pass.

### Step 7: Commit

```bash
git add src/server/serializers.ts src/server/serializers.test.ts
git commit -m "feat(server): add event serialization types and helpers"
```
