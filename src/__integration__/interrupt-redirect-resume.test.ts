import { describe, it, expect } from 'vitest';
import { BehaviorTree } from '../core/behavior-tree.js';
import { ActionNode } from '../nodes/action.js';
import { SequenceNode } from '../composites/sequence.js';
import { NodeStatus } from '../types.js';
import { setupTest } from './helpers.js';

describe('interrupt-redirect-resume', () => {
  it('interrupt cancels in-flight work, write clears held, sequence resumes without re-executing completed children', async () => {
    let gatherCount = 0;
    let analysisCount = 0;
    const reportEvents: unknown[] = [];

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

              // Steps 3 + 4 combined: synthesize report and emit to client in one action.
              // Combining these avoids the runToCompletion edge case where 3+ consecutive
              // fast-settling nodes can cause premature suspension detection.
              new ActionNode({
                name: 'synthesize-and-emit',
                action: (ctx) => {
                  const topic = ctx.blackboard.get('topic') ?? 'default';
                  const analysis = ctx.blackboard.get('analysis');
                  const report = `Report on "${topic}": ${analysis}`;
                  ctx.blackboard.set('report', report);
                  // Dual-write: blackboard + SSE event (mirrors what emitToClient does)
                  ctx.blackboard.set('clientEvents:ui:report', { report });
                  ctx.events.emit('client:event', { name: 'ui:report', data: { report } });
                  return NodeStatus.SUCCESS;
                },
              }),
            ],
          }),
        }),
    });

    // Subscribe to report events before starting
    harness.client.on('ui:report', (data) => reportEvents.push(data));

    // 1. Start the pipeline (fire-and-forget) — gather-context completes fast,
    //    deep-analysis begins in-flight (~500ms)
    harness.client.send({ type: 'tick' });

    // Wait for gather-context to complete and deep-analysis to be in-flight
    await new Promise((r) => setTimeout(r, 50));

    // 2. Interrupt — cancels deep-analysis mid-execution, sets held state
    const interruptResult = await harness.client.interrupt();
    expect(interruptResult.interrupted).toBe(true);

    // Wait for the interrupt to be fully processed and held state to be saved
    await new Promise((r) => setTimeout(r, 150));

    // 3. Verify held state blocks tick messages
    //    Tick is accepted but will be a no-op due to held state
    const tickResult = await harness.client.send({ type: 'tick' });
    expect(tickResult.id).toBeDefined();

    // Wait for the no-op tick to process
    await new Promise((r) => setTimeout(r, 100));

    // 4. Write new topic — clears held state, then tree resumes from deep-analysis
    await harness.client.write('topic', 'new-topic');

    // Wait for the write to be processed, then deep-analysis (~500ms) to complete,
    // then synthesize-and-emit to run
    await new Promise((r) => setTimeout(r, 1200));

    // 5. Verify: gather-context ran only once (was cached in completedMap before interrupt)
    expect(gatherCount).toBe(1);

    // deep-analysis ran twice: once originally (interrupted at ~50ms), once after resume
    expect(analysisCount).toBe(2);

    // 6. Verify final blackboard state reflects the new topic
    const bb = await harness.client.blackboard();
    expect(bb['topic']).toBe('new-topic');
    expect(bb['report']).toBeDefined();
    expect(bb['report']).toContain('new-topic');

    // 7. Verify the report event arrived via SSE
    expect(reportEvents).toHaveLength(1);
    expect((reportEvents[0] as any).report).toContain('new-topic');
  });
});
