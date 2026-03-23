# Task 158: Session Concurrency Validation

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add static validation that prevents two AgentNodes in resume mode on the same session from executing concurrently under a ParallelNode.

**Depends on:** Task 156 (BehaviorTree sessions), Task 157 (AgentNode session resolution)

**Spec Reference:** `docs/superpowers/specs/2026-03-23-agent-sessions-design.md` — Validation section

---

### Step 1: Write failing tests

Create `src/core/session-validation.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { validateSessionConcurrency } from './session-validation.js';
import { AgentNode } from '../nodes/agent.js';
import { SequenceNode } from '../composites/sequence.js';
import { SelectorNode } from '../composites/selector.js';
import { ParallelNode } from '../composites/parallel.js';
import { ActionNode } from '../nodes/action.js';
import { TestAgent } from '../agent/test-agent.js';
import { NodeStatus } from '../types.js';

function makeAgentNode(name: string, session?: string | { name: string; fork?: true | string }): AgentNode {
  return new AgentNode({
    name,
    agent: new TestAgent({ name }),
    prompt: 'test',
    session,
  });
}

describe('validateSessionConcurrency', () => {
  it('allows two resume-mode agents on the same session in a SequenceNode', () => {
    const root = new SequenceNode({
      name: 'seq',
      children: [
        makeAgentNode('a', 'triage'),
        makeAgentNode('b', 'triage'),
      ],
    });
    expect(() => validateSessionConcurrency(root)).not.toThrow();
  });

  it('allows two resume-mode agents on the same session in a SelectorNode', () => {
    const root = new SelectorNode({
      name: 'sel',
      children: [
        makeAgentNode('a', 'triage'),
        makeAgentNode('b', 'triage'),
      ],
    });
    expect(() => validateSessionConcurrency(root)).not.toThrow();
  });

  it('throws when two resume-mode agents on the same session are in different branches of a ParallelNode', () => {
    const root = new ParallelNode({
      name: 'par',
      children: [
        makeAgentNode('a', 'triage'),
        makeAgentNode('b', 'triage'),
      ],
    });
    expect(() => validateSessionConcurrency(root)).toThrow(/session.*"triage".*ParallelNode/i);
  });

  it('allows fork-mode agents on the same session in a ParallelNode', () => {
    const root = new ParallelNode({
      name: 'par',
      children: [
        makeAgentNode('a', { name: 'triage', fork: true }),
        makeAgentNode('b', { name: 'triage', fork: true }),
      ],
    });
    expect(() => validateSessionConcurrency(root)).not.toThrow();
  });

  it('allows named fork agents on the same session in a ParallelNode', () => {
    const root = new ParallelNode({
      name: 'par',
      children: [
        makeAgentNode('a', { name: 'triage', fork: 'a-thread' }),
        makeAgentNode('b', { name: 'triage', fork: 'b-thread' }),
      ],
    });
    expect(() => validateSessionConcurrency(root)).not.toThrow();
  });

  it('allows one resume and one fork on the same session in a ParallelNode', () => {
    const root = new ParallelNode({
      name: 'par',
      children: [
        makeAgentNode('a', 'triage'),
        makeAgentNode('b', { name: 'triage', fork: true }),
      ],
    });
    // Only one resume — valid (no concurrent resume conflict)
    expect(() => validateSessionConcurrency(root)).not.toThrow();
  });

  it('throws for resume conflicts in deeply nested parallel branches', () => {
    const root = new ParallelNode({
      name: 'par',
      children: [
        new SequenceNode({
          name: 'branch-a',
          children: [
            makeAgentNode('a1', 'triage'),
          ],
        }),
        new SequenceNode({
          name: 'branch-b',
          children: [
            makeAgentNode('b1', 'triage'),
          ],
        }),
      ],
    });
    expect(() => validateSessionConcurrency(root)).toThrow(/session.*"triage".*ParallelNode/i);
  });

  it('allows different session names in parallel branches', () => {
    const root = new ParallelNode({
      name: 'par',
      children: [
        makeAgentNode('a', 'session-a'),
        makeAgentNode('b', 'session-b'),
      ],
    });
    expect(() => validateSessionConcurrency(root)).not.toThrow();
  });

  it('validates nested ParallelNodes independently', () => {
    const root = new SequenceNode({
      name: 'seq',
      children: [
        new ParallelNode({
          name: 'par-1',
          children: [
            makeAgentNode('a', 'alpha'),
            makeAgentNode('b', 'beta'),
          ],
        }),
        new ParallelNode({
          name: 'par-2',
          children: [
            makeAgentNode('c', 'alpha'),
            makeAgentNode('d', 'beta'),
          ],
        }),
      ],
    });
    // Each ParallelNode has different sessions per branch — valid
    expect(() => validateSessionConcurrency(root)).not.toThrow();
  });

  it('passes when no agents have session config', () => {
    const root = new SequenceNode({
      name: 'seq',
      children: [
        makeAgentNode('a'),
        new ActionNode({ name: 'action', action: async () => NodeStatus.SUCCESS }),
      ],
    });
    expect(() => validateSessionConcurrency(root)).not.toThrow();
  });
});
```

### Step 2: Run tests to verify they fail

Run: `pnpm --filter cartographer exec vitest run src/core/session-validation.test.ts`

Expected: FAIL — `session-validation.js` does not exist.

### Step 3: Implement validateSessionConcurrency

Create `src/core/session-validation.ts`:

```ts
import { ParallelNode } from '../composites/parallel.js';
import type { BTreeNode } from '../types.js';
import type { SessionConfig } from '../types.js';

/**
 * Validate that no two AgentNodes in resume mode on the same named session
 * can execute concurrently within a ParallelNode.
 *
 * Fork-mode agents are excluded from this check — any number of agents can
 * fork the same session concurrently without conflict.
 *
 * This validation runs at tree construction time. It walks the tree and
 * checks each ParallelNode's branches for conflicting resume-mode sessions.
 *
 * @throws {Error} If two resume-mode agents on the same session are found
 *   in different branches of the same ParallelNode.
 */
export function validateSessionConcurrency(root: BTreeNode): void {
  walkForParallelNodes(root);
}

function walkForParallelNodes(node: BTreeNode): void {
  if (node instanceof ParallelNode) {
    checkParallelBranches(node);
  }
  for (const child of node.children) {
    walkForParallelNodes(child);
  }
}

function checkParallelBranches(parallel: BTreeNode): void {
  const branchSessions: Set<string>[] = parallel.children.map((child) =>
    collectResumeSessions(child),
  );

  for (let i = 0; i < branchSessions.length; i++) {
    for (let j = i + 1; j < branchSessions.length; j++) {
      for (const session of branchSessions[i]) {
        if (branchSessions[j].has(session)) {
          throw new Error(
            `Session concurrency conflict in ParallelNode "${parallel.name}": ` +
            `session "${session}" is resumed in multiple branches. ` +
            `Use fork mode for agents that need concurrent access to the same session.`,
          );
        }
      }
    }
  }
}

function collectResumeSessions(node: BTreeNode): Set<string> {
  const sessions = new Set<string>();

  const config = getSessionConfig(node);
  if (config && !config.fork) {
    sessions.add(config.name);
  }

  for (const child of node.children) {
    for (const s of collectResumeSessions(child)) {
      sessions.add(s);
    }
  }

  return sessions;
}

/**
 * Duck-type check for AgentNode's sessionConfig getter.
 * Avoids importing AgentNode directly to prevent tight coupling.
 */
function getSessionConfig(node: BTreeNode): SessionConfig | null {
  if ('sessionConfig' in node) {
    const config = (node as any).sessionConfig;
    // Guard against typeof null === 'object' — sessionConfig returns null when no session is set
    return config != null && typeof config === 'object' ? (config as SessionConfig) : null;
  }
  return null;
}
```

### Step 4: Run tests to verify they pass

Run: `pnpm --filter cartographer exec vitest run src/core/session-validation.test.ts`

Expected: All pass.

### Step 5: Wire validation into BehaviorTree constructor

Modify `src/core/behavior-tree.ts`:

Add import:

```ts
import { validateSessionConcurrency } from './session-validation.js';
```

In the constructor, after the `validateUniqueIds` call (line 79):

```ts
    validateSessionConcurrency(this.root);
```

### Step 6: Run full test suite

Run: `pnpm --filter cartographer test`

Expected: All pass. Existing trees without session config will pass validation (no resume-mode agents = nothing to conflict).

### Step 7: Typecheck

Run: `pnpm typecheck`

### Step 8: Commit

```bash
git add packages/cartographer/src/core/session-validation.ts packages/cartographer/src/core/session-validation.test.ts packages/cartographer/src/core/behavior-tree.ts
git commit -m "feat(core): add session concurrency validation for ParallelNode"
```
