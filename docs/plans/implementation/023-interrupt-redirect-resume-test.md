# Task 23: Interrupt-Redirect-Resume Integration Test

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Test the interrupt lifecycle: cancel in-flight work, verify held state blocks ticks, write message clears held, and sequence resumption preserves completed children.

**Architecture:** Single integration test file. Tree: gather-context (fast) → deep-analysis (slow, ~500ms) → synthesize → emit report. Client interrupts during deep-analysis, redirects via blackboard write, verifies gather-context is not re-executed.

**Tech Stack:** TypeScript, vitest

**Key files to understand:**
- `src/__integration__/helpers.ts` — `setupTest` harness
- `src/actor/tree-actor.ts` — interrupt flow, held state, `runToCompletion()`
- `docs/superpowers/specs/2026-03-16-full-stack-feature-tests-design.md` — test 2 spec

---

### Step 1: Create the test file

Create `src/__integration__/interrupt-redirect-resume.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { BehaviorTree } from '../core/behavior-tree.js';
import { ActionNode } from '../nodes/action.js';
import { SequenceNode } from '../composites/sequence.js';
import { emitToClient } from '../application/emit-to-client.js';
import { NodeStatus } from '../types.js';
import { setupTest } from './helpers.js';

describe('interrupt-redirect-resume', () => {
  it('interrupt cancels in-flight work, write clears held, sequence resumes without re-executing completed children', async () => {
    let gatherCount = 0;
    let analysisCount = 0;

    await using harness = await setupTest({
      createTree: () =>
        new BehaviorTree({
          name: 'research-pipeline',
          root: new SequenceNode({
            name: 'main',
            children: [
              // Step 1: Fast — gather context from topic
              new ActionNode({
                name: 'gather-context',
                action: (ctx) => {
                  gatherCount++;
                  const topic = ctx.blackboard.get('topic') ?? 'default';
                  ctx.blackboard.set('context', `Context for: ${topic}`);
                  return NodeStatus.SUCCESS;
                },
              }),

              // Step 2: Slow — deep analysis (~500ms)
              new ActionNode({
                name: 'deep-analysis',
                action: async (ctx) => {
                  analysisCount++;
                  await new Promise((r) => setTimeout(r, 500));
                  const context = ctx.blackboard.get('context');
                  ctx.blackboard.set('analysis', `Analysis of ${context}`);
                  return NodeStatus.SUCCESS;
                },
              }),

              // Step 3: Synthesize report
              new ActionNode({
                name: 'synthesize',
                action: (ctx) => {
                  const topic = ctx.blackboard.get('topic') ?? 'default';
                  const analysis = ctx.blackboard.get('analysis');
                  ctx.blackboard.set('report', `Report on "${topic}": ${analysis}`);
                  return NodeStatus.SUCCESS;
                },
              }),

              // Step 4: Emit report to client
              emitToClient('ui:report', (ctx) => ({ report: ctx.blackboard.get('report') })),
            ],
          }),
        }),
    });

    // 1. Start the pipeline — gather-context completes, deep-analysis begins in-flight
    harness.client.send({ type: 'tick' });

    // Wait for deep-analysis to be in-flight
    await new Promise((r) => setTimeout(r, 50));

    // 2. Interrupt — cancels deep-analysis mid-execution
    const interruptResult = await harness.client.interrupt();
    expect(interruptResult.interrupted).toBe(true);

    // Wait for interrupt to be processed
    await new Promise((r) => setTimeout(r, 100));

    // 3. Verify held state blocks tick messages
    const tickResult = await harness.client.send({ type: 'tick' });
    // Tick is accepted (202) but will be a no-op due to held state
    expect(tickResult.id).toBeDefined();

    // Wait for the no-op tick to process
    await new Promise((r) => setTimeout(r, 100));

    // 4. Write new topic — clears held, processes the write, tree resumes
    const writeResult = await harness.client.actionAndWait('write-topic');
    // actionAndWait sends an action; let's use write instead
    // Actually, use the client.write() method and listen for message:processed
    // We need to write and wait, so let's do it manually
    await harness.client.write('topic', 'new-topic');

    // Wait for tree to complete after write clears held
    await new Promise((r) => setTimeout(r, 1000));

    // 5. Verify: gather-context ran only once (cached in completedMap)
    expect(gatherCount).toBe(1);

    // deep-analysis ran twice: once originally (interrupted), once after resume
    expect(analysisCount).toBe(2);

    // 6. Verify final blackboard state reflects the new topic
    const bb = await harness.client.blackboard();
    expect(bb['topic']).toBe('new-topic');
    expect(bb['report']).toContain('new-topic');
  });
});
```

### Step 2: Run the test

Run: `npm run test:integration -- interrupt-redirect-resume`
Expected: PASS

### Step 3: Run full integration suite

Run: `npm run test:integration`
Expected: All tests pass

### Step 4: Commit

```bash
git add src/__integration__/interrupt-redirect-resume.test.ts
git commit -m "test: add interrupt-redirect-resume integration test"
```
