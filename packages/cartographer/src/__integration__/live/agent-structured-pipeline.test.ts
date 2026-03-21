import { describe, it, expect } from 'vitest';
import { BehaviorTree } from '../../core/behavior-tree.js';
import { ActionNode } from '../../nodes/action.js';
import { AgentNode } from '../../nodes/agent.js';
import { ConditionNode } from '../../nodes/condition.js';
import { SequenceNode } from '../../composites/sequence.js';
import { SelectorNode } from '../../composites/selector.js';
import { emitToClient } from '../../nodes/emit-to-client.js';
import { receive } from '../../nodes/receive.js';
import { untilSuccess } from '../../decorators/until-success.js';
import { NodeStatus } from '../../types.js';
import { setupTest, waitForBlackboard } from '../helpers.js';

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
                options: {
                  model: 'claude-haiku-4-5-20251001',
                  effort: 'low',
                  outputFormat: {
                    type: 'json_schema',
                    schema: {
                      type: 'object',
                      properties: {
                        category: { type: 'string' },
                        confidence: { type: 'number' },
                        tags: { type: 'array', items: { type: 'string' } },
                      },
                      required: ['category', 'confidence', 'tags'],
                    },
                  },
                },
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
                          const parsed = typeof output === 'string' ? JSON.parse(output) : output;
                          return typeof parsed.confidence === 'number' && parsed.confidence > 0.5;
                        },
                      }),
                      // Combine auto-publish + emit into one action to avoid the
                      // runToCompletion edge case where 3+ consecutive fast-settling
                      // nodes cause premature suspension detection.
                      new ActionNode({
                        name: 'auto-publish-and-emit',
                        action: (ctx) => {
                          ctx.blackboard.set('published', true);
                          ctx.blackboard.set('publish-mode', 'auto');
                          const output = ctx.blackboard.get('classifier:classify:output');
                          // Dual-write: blackboard + SSE event (mirrors what emitToClient does)
                          ctx.blackboard.set('clientEvents:ui:published', output);
                          ctx.events.emit('client:event', { name: 'ui:published', data: output });
                          return NodeStatus.SUCCESS;
                        },
                      }),
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
                            receive('confirm-classification'),
                            receive('reclassify'),
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

    // Start pipeline — ingest runs synchronously, then agent classifies asynchronously.
    // Use send (non-blocking) since actionAndWait would time out waiting for the agent.
    await harness.client.send({ type: 'tick' });

    // Wait for the agent to produce structured classification output.
    const classificationOutput = await waitForBlackboard(
      harness.client,
      'classifier:classify:output',
      60000,
      1000,
    );

    // Intermediate assertion: classification output must have the expected structure
    // before we proceed to branch-dependent behaviour.
    expect(classificationOutput).toBeDefined();
    const parsed =
      typeof classificationOutput === 'string'
        ? JSON.parse(classificationOutput as string)
        : (classificationOutput as any);
    expect(parsed).toBeDefined();
    expect(typeof parsed.category).toBe('string');
    expect(typeof parsed.confidence).toBe('number');
    expect(Array.isArray(parsed.tags)).toBe(true);

    // Read the full blackboard once to determine which path the tree took.
    let bb = await harness.client.blackboard();

    if (bb['clientEvents:ui:needs-review'] != null && bb['published'] == null) {
      // Low-confidence path: confirm the classification so the tree can proceed.
      await harness.client.actionAndWait('confirm-classification');
      // Wait for manual-publish to set the key rather than using a fixed delay.
      await waitForBlackboard(harness.client, 'published', 10000, 500);
      bb = await harness.client.blackboard();
    }

    // Verify: document was published through one of the two paths
    expect(bb['published']).toBe(true);
    expect(['auto', 'manual']).toContain(bb['publish-mode']);
  }, 90000);
});
