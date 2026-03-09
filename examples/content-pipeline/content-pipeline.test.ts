import { describe, it, expect } from 'vitest';
import { NodeStatus } from '../../src/index.js';
import { buildContentPipeline } from './tree.js';
import { SAMPLE_TICKET } from './prompts.js';

describe('content-pipeline example', { timeout: 120_000 }, () => {
  it('processes a support ticket end-to-end', async () => {
    const tree = buildContentPipeline();
    tree.blackboard.set('ticket', SAMPLE_TICKET);

    const { status, blackboard } = await tree.run();

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
