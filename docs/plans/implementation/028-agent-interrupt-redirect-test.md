# Task 28: Agent Interrupt and Redirect Live Test

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Test interrupting a real `AgentNode` mid-research, redirecting with a new topic via blackboard write, and verifying the agent re-invokes with the new context.

**Architecture:** Single live integration test file. Tree: set-topic (actionReceived) → agent researches topic (dynamic prompt reads blackboard) → format-report → emit report. Client sets topic, interrupts the agent, writes a new topic, and verifies output reflects the redirect.

**Tech Stack:** TypeScript, vitest, `@anthropic-ai/claude-agent-sdk`

**Key files to understand:**
- `src/__integration__/helpers.ts` — `setupTest` harness
- `src/nodes/agent.ts` — `AgentNode` with function prompt for dynamic context
- `src/actor/tree-actor.ts` — interrupt, held state, `completedMap` preservation
- Agent output key formula: `${namespace}:${name}:output`
- `docs/superpowers/specs/2026-03-16-full-stack-feature-tests-design.md` — test 7 spec

**Prerequisites:** Requires `ANTHROPIC_API_KEY` environment variable. This test goes in `src/__integration__/live/`.

---

### Step 1: Create the test file

Create `src/__integration__/live/agent-interrupt-and-redirect.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { BehaviorTree } from '../../core/behavior-tree.js';
import { ActionNode } from '../../nodes/action.js';
import { AgentNode } from '../../nodes/agent.js';
import { SequenceNode } from '../../composites/sequence.js';
import { emitToClient } from '../../application/emit-to-client.js';
import { actionReceived } from '../../application/action-received.js';
import { untilSuccess } from '../../application/until-success.js';
import { NodeStatus } from '../../types.js';
import { setupTest } from '../helpers.js';

describe('agent interrupt and redirect (live)', () => {
  it('interrupts agent mid-research, redirects with new topic, verifies new output', async () => {
    let topicSetCount = 0;

    await using harness = await setupTest({
      createTree: () =>
        new BehaviorTree({
          name: 'research-assistant',
          root: new SequenceNode({
            name: 'main',
            children: [
              // Wait for topic to be set
              untilSuccess(
                actionReceived('set-topic', {
                  mapPayload: (payload, bb) => {
                    topicSetCount++;
                    bb.set('research:topic', (payload as any)?.topic ?? 'unknown');
                  },
                }),
              ),

              // Agent researches — reads topic from blackboard via dynamic prompt
              new AgentNode({
                name: 'research',
                prompt: (ctx) => {
                  const topic = ctx.blackboard.get('research:topic');
                  return (
                    `Research the following topic and provide a brief summary. ` +
                    `Return a JSON object with "summary" (string) and "keyFindings" (array of strings). ` +
                    `Keep findings concise (1 sentence each). Topic: ${topic}`
                  );
                },
                blackboardNamespace: 'researcher',
              }),

              // Format the report
              new ActionNode({
                name: 'format-report',
                action: (ctx) => {
                  const output = ctx.blackboard.get('researcher:research:output');
                  const topic = ctx.blackboard.get('research:topic');
                  ctx.blackboard.set('report', { topic, output });
                  return NodeStatus.SUCCESS;
                },
              }),

              // Emit report to client
              emitToClient('ui:report', (ctx) => ctx.blackboard.get('report')),
            ],
          }),
        }),
    });

    // 1. Set topic and start the agent
    await harness.client.action('set-topic', { topic: 'quantum computing basics' });

    // Wait for agent to be in-flight (~3s should be enough for it to start)
    await new Promise((r) => setTimeout(r, 3000));

    // 2. Interrupt the agent mid-research
    const interruptResult = await harness.client.interrupt();
    expect(interruptResult.interrupted).toBe(true);

    // Wait for interrupt to settle
    await new Promise((r) => setTimeout(r, 500));

    // 3. Redirect: write new topic — clears held state
    await harness.client.write('research:topic', 'history of the internet');

    // 4. Wait for tree to complete (agent restarts with new topic, finishes, report emitted)
    let bb: Record<string, unknown> = {};
    const startTime = Date.now();
    while (Date.now() - startTime < 60000) {
      await new Promise((r) => setTimeout(r, 2000));
      bb = await harness.client.blackboard();
      if (bb['report'] != null) break;
    }

    // 5. Verify: topic was set only once (completedMap preserved set-topic)
    expect(topicSetCount).toBe(1);

    // 6. Verify: agent output exists
    const agentOutput = bb['researcher:research:output'];
    expect(agentOutput).toBeDefined();

    // 7. Verify: report reflects the NEW topic, not the original
    const report = bb['report'] as any;
    expect(report).toBeDefined();
    expect(report.topic).toBe('history of the internet');
  }, 90000); // 90s timeout for API calls
});
```

### Step 2: Run the test

Run: `npm run test:live -- agent-interrupt-and-redirect`
Expected: PASS (requires `ANTHROPIC_API_KEY`)

### Step 3: Commit

```bash
git add src/__integration__/live/agent-interrupt-and-redirect.test.ts
git commit -m "test: add agent interrupt and redirect live integration test"
```
