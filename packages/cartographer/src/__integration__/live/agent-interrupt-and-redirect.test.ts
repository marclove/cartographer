import { describe, it, expect } from 'vitest';
import { BehaviorTree } from '../../core/behavior-tree.js';
import { ActionNode } from '../../nodes/action.js';
import { AgentNode } from '../../nodes/agent.js';
import { SequenceNode } from '../../composites/sequence.js';
import { receive } from '../../nodes/receive.js';
import { untilSuccess } from '../../decorators/until-success.js';
import { NodeStatus } from '../../types.js';
import { setupTest, waitForEvent, waitForBlackboard } from '../helpers.js';

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
                receive('set-topic', {
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

              // Format the report and emit to client in one action.
              // Combined to avoid the runToCompletion edge case where consecutive
              // fast-settling nodes cause premature suspension detection.
              new ActionNode({
                name: 'format-and-emit',
                action: (ctx) => {
                  const output = ctx.blackboard.get('researcher:research:output');
                  const topic = ctx.blackboard.get('research:topic');
                  const report = { topic, output };
                  ctx.blackboard.set('report', report);
                  // Dual-write: blackboard + SSE event (mirrors what emitToClient does)
                  ctx.blackboard.set('clientEvents:ui:report', report);
                  ctx.events.emit('client:event', { name: 'ui:report', data: report });
                  return NodeStatus.SUCCESS;
                },
              }),
            ],
          }),
        }),
    });

    // 1. Set topic and start the agent.
    // The blackboard isn't persisted until runToCompletion finishes, so we can't
    // use waitForBlackboard here. A fixed delay is the appropriate strategy —
    // we need the agent to be mid-API-call, not just started.
    await harness.client.action('set-topic', { topic: 'quantum computing basics' });
    await new Promise((r) => setTimeout(r, 3000));

    // 2. Interrupt the agent mid-research.
    // Register the listener BEFORE calling interrupt() to avoid a race where the
    // event fires before we start listening.
    const interruptSettled = waitForEvent(harness.client, 'message:interrupted', 1, 10000);
    const interruptResult = await harness.client.interrupt();
    expect(interruptResult.interrupted).toBe(true);

    // Wait for the interrupt to fully settle
    await interruptSettled;

    // Verify topic is still set after interrupt
    const bbAfterInterrupt = await harness.client.blackboard();
    expect(bbAfterInterrupt['research:topic']).toBe('quantum computing basics');

    // 3. Redirect: write new topic — clears held state, agent restarts with new topic
    await harness.client.write('research:topic', 'history of the internet');

    // 4. Wait for tree to complete (agent restarts with new topic, finishes, report emitted)
    await waitForBlackboard(harness.client, 'report', 60000, 2000);
    const bb = await harness.client.blackboard();

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
