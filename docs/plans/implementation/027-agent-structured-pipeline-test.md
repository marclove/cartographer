# Task 27: Agent Structured Pipeline Live Test

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Test a real `AgentNode` with structured output via `options.outputFormat` in a conditional workflow that branches on agent confidence.

**Architecture:** Single live integration test file. Tree: ingest-document → agent classifies with structured output → selector branches on confidence (high → auto-publish, low → emit for review → wait for action → manual-publish). Test handles both paths since agent output is non-deterministic.

**Tech Stack:** TypeScript, vitest, `@anthropic-ai/claude-agent-sdk`

**Key files to understand:**
- `src/__integration__/helpers.ts` — `setupTest` harness
- `src/nodes/agent.ts` — `AgentNode`, `prompt`, `options.outputFormat`, `blackboardNamespace`
- Agent output key formula: `${namespace}:${name}:output`
- `docs/superpowers/specs/2026-03-16-full-stack-feature-tests-design.md` — test 6 spec

**Prerequisites:** Requires `ANTHROPIC_API_KEY` environment variable. This test goes in `src/__integration__/live/`.

---

### Step 1: Create the test file

Create `src/__integration__/live/agent-structured-pipeline.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { BehaviorTree } from '../../core/behavior-tree.js';
import { ActionNode } from '../../nodes/action.js';
import { AgentNode } from '../../nodes/agent.js';
import { ConditionNode } from '../../nodes/condition.js';
import { SequenceNode } from '../../composites/sequence.js';
import { SelectorNode } from '../../composites/selector.js';
import { emitToClient } from '../../application/emit-to-client.js';
import { actionReceived } from '../../application/action-received.js';
import { untilSuccess } from '../../application/until-success.js';
import { NodeStatus } from '../../types.js';
import { setupTest } from '../helpers.js';

describe('agent structured pipeline (live)', () => {
  it('classifies a document and branches on confidence', async () => {
    await using harness = await setupTest({
      createTree: () =>
        new BehaviorTree({
          name: 'classification-pipeline',
          root: new SequenceNode({
            name: 'main',
            children: [
              // Ingest the document
              new ActionNode({
                name: 'ingest-document',
                action: (ctx) => {
                  ctx.blackboard.set(
                    'document',
                    'RFC 9421 defines HTTP Message Signatures, a mechanism for creating, ' +
                    'encoding, and verifying digital signatures or message authentication ' +
                    'codes over components of an HTTP message.',
                  );
                  return NodeStatus.SUCCESS;
                },
              }),

              // Agent classifies with structured output
              new AgentNode({
                name: 'classify',
                prompt: (ctx) =>
                  `Classify the following document into a category. ` +
                  `Return a JSON object with "category" (string), "confidence" (number 0-1), ` +
                  `and "tags" (array of strings). Be very confident in your classification.\n\n` +
                  `Document: ${ctx.blackboard.get('document')}`,
                blackboardNamespace: 'classifier',
              }),

              // Branch on confidence
              new SelectorNode({
                name: 'confidence-routing',
                children: [
                  // High confidence path
                  new SequenceNode({
                    name: 'high-confidence',
                    children: [
                      new ConditionNode({
                        name: 'is-confident',
                        condition: (ctx) => {
                          const output = ctx.blackboard.get('classifier:classify:output') as any;
                          if (!output) return false;
                          // Parse if string
                          const parsed = typeof output === 'string' ? JSON.parse(output) : output;
                          return typeof parsed.confidence === 'number' && parsed.confidence > 0.5;
                        },
                      }),
                      new ActionNode({
                        name: 'auto-publish',
                        action: (ctx) => {
                          ctx.blackboard.set('published', true);
                          ctx.blackboard.set('publish-mode', 'auto');
                          return NodeStatus.SUCCESS;
                        },
                      }),
                      emitToClient('ui:published', (ctx) =>
                        ctx.blackboard.get('classifier:classify:output'),
                      ),
                    ],
                  }),

                  // Low confidence path
                  new SequenceNode({
                    name: 'low-confidence',
                    children: [
                      emitToClient('ui:needs-review', (ctx) =>
                        ctx.blackboard.get('classifier:classify:output'),
                      ),
                      untilSuccess(
                        new SelectorNode({
                          name: 'review-decision',
                          children: [
                            actionReceived('confirm-classification'),
                            actionReceived('reclassify'),
                          ],
                        }),
                      ),
                      new ActionNode({
                        name: 'manual-publish',
                        action: (ctx) => {
                          ctx.blackboard.set('published', true);
                          ctx.blackboard.set('publish-mode', 'manual');
                          return NodeStatus.SUCCESS;
                        },
                      }),
                    ],
                  }),
                ],
              }),
            ],
          }),
        }),
    });

    // 1. Start pipeline — ingest document, agent classifies
    // Use send + polling since agent takes time
    await harness.client.send({ type: 'tick' });

    // Wait for agent to complete (poll blackboard for classification output)
    let bb: Record<string, unknown> = {};
    const startTime = Date.now();
    while (Date.now() - startTime < 60000) {
      await new Promise((r) => setTimeout(r, 1000));
      bb = await harness.client.blackboard();
      if (bb['published'] === true) break;
      // If low confidence path, check if needs-review was emitted
      if (bb['clientEvents:ui:needs-review'] != null && bb['published'] == null) {
        // Send confirmation action to proceed
        await harness.client.action('confirm-classification');
        await new Promise((r) => setTimeout(r, 2000));
        bb = await harness.client.blackboard();
        break;
      }
    }

    // 2. Verify: document was classified with structured output
    const classificationOutput = bb['classifier:classify:output'];
    expect(classificationOutput).toBeDefined();

    // 3. Verify: published through one of the two paths
    expect(bb['published']).toBe(true);
    expect(['auto', 'manual']).toContain(bb['publish-mode']);
  }, 90000); // 90s timeout for API call
});
```

### Step 2: Run the test

Run: `npm run test:live -- agent-structured-pipeline`
Expected: PASS (requires `ANTHROPIC_API_KEY`)

### Step 3: Commit

```bash
git add src/__integration__/live/agent-structured-pipeline.test.ts
git commit -m "test: add agent structured pipeline live integration test"
```
