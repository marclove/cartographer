import { describe, it, expect, afterEach } from 'vitest';
import { NodeStatus, createTreeLogger } from 'cartographer';
import { buildContentPipeline } from './tree.js';
import { SAMPLE_TICKET } from './prompts.js';

const LOG_FILE = 'logs/content-pipeline.log';

let stopLogging: (() => void) | undefined;
afterEach(() => { stopLogging?.(); stopLogging = undefined; });

describe('content-pipeline example', { timeout: 120_000 }, () => {
  it('processes a support ticket end-to-end', async () => {
    const tree = buildContentPipeline();
    stopLogging = createTreeLogger(tree.events, { filePath: LOG_FILE, logBlackboard: true });
    tree.blackboard.set('ticket', SAMPLE_TICKET);

    // Tick until the tree completes (RUNNING means inflight work is pending)
    let status = await tree.tick();
    while (status === NodeStatus.RUNNING) {
      await new Promise(r => setTimeout(r, 1_000));
      status = await tree.tick();
    }
    const blackboard = 'toRecord' in tree.blackboard && typeof (tree.blackboard as any).toRecord === 'function'
      ? (tree.blackboard as any).toRecord()
      : {};

    // Pipeline should complete successfully
    expect(status).toBe(NodeStatus.SUCCESS);

    // Classification should exist with expected shape.
    // The sample ticket is a billing complaint, so the classifier should route billing.
    const classification = blackboard['classify:output'] as Record<string, unknown>;
    expect(classification).toBeDefined();
    expect(classification.category).toBe('billing');
    expect(classification.urgency).toBeDefined();

    // Triage report should be consolidated
    const report = blackboard['triage:report'] as Record<string, unknown>;
    expect(report).toBeDefined();
    expect(report.classification).toBeDefined();
    expect(report.response).toBeDefined();
  });
});
