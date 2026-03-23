import { describe, it, expect, afterEach } from 'vitest';
import { NodeStatus } from '../../types.js';
import { ActionNode } from '../../nodes/action.js';
import { ParallelNode } from '../../composites/parallel.js';
import { AgentSelectionStrategy } from '../../strategies/agent-selection.js';
import { AgentParallelStrategy } from '../../strategies/agent-parallel.js';
import { ClaudeSDKAgent } from '../../agent/claude-sdk-agent.js';
import { createContext, collectEvents } from '../helpers.js';
import { createTreeLogger } from '../../tree-logger.js';

const LOG_FILE = 'logs/live-agent-strategies.log';

let stopLogging: (() => void) | undefined;
afterEach(() => { stopLogging?.(); stopLogging = undefined; });

describe('Agent Strategies Integration (Live API)', { timeout: 60_000 }, () => {
  it('AgentParallelStrategy end-to-end with live API', async () => {
    const ctx = createContext();
    stopLogging = createTreeLogger(ctx.events, { filePath: LOG_FILE });
    const strategyEvents = collectEvents(ctx, 'strategy:decision');

    const strategy = new AgentParallelStrategy({
      prompt: 'Choose a policy that requires at least 2 successes out of 3 children.',
      agent: new ClaudeSDKAgent({ name: 'parallel-strategy', model: 'claude-haiku-4-5', effort: 'low' }),
    });

    const children = [
      new ActionNode({ name: 'task-a', action: () => NodeStatus.SUCCESS }),
      new ActionNode({ name: 'task-b', action: () => NodeStatus.SUCCESS }),
      new ActionNode({ name: 'task-c', action: () => NodeStatus.SUCCESS }),
    ];

    const parallel = new ParallelNode({
      name: 'live-par',
      children,
      strategy,
    });

    // First tick: strategy resolves policy, all actions start inflight → RUNNING
    const status1 = await parallel.tick(ctx);
    expect(status1).toBe(NodeStatus.RUNNING);

    // Wait for sync actions to resolve, then poll
    await new Promise(r => setTimeout(r, 0));
    const status2 = await parallel.tick(ctx);

    expect(status2).toBe(NodeStatus.SUCCESS);
    expect(strategyEvents).toHaveLength(1);

    const decision = strategyEvents[0].decision as any;
    expect(decision.policy).toBeDefined();
    expect(typeof decision.reasoning).toBe('string');
  });

  it('AgentSelectionStrategy reorders children', async () => {
    const ctx = createContext({ task: 'file-processing' });
    stopLogging = createTreeLogger(ctx.events, { filePath: LOG_FILE });
    const strategyEvents = collectEvents(ctx, 'strategy:decision');

    const children = [
      new ActionNode({ name: 'upload-to-cloud', action: () => NodeStatus.SUCCESS }),
      new ActionNode({ name: 'validate-format', action: () => NodeStatus.SUCCESS }),
      new ActionNode({ name: 'compress-file', action: () => NodeStatus.SUCCESS }),
    ];

    const strategy = new AgentSelectionStrategy({
      prompt: 'Order these file processing steps in the most logical sequence for processing a file.',
      agent: new ClaudeSDKAgent({ name: 'selection-strategy', model: 'claude-haiku-4-5', effort: 'low' }),
      childDescriptions: {
        'upload-to-cloud': 'Upload the processed file to cloud storage',
        'validate-format': 'Check if the file format is valid',
        'compress-file': 'Compress the file to reduce size',
      },
    });

    const reordered = await strategy.order(children, ctx);

    // All children should be present (possibly reordered)
    expect(reordered).toHaveLength(3);
    const reorderedNames = reordered.map((c) => c.name);
    expect(reorderedNames).toContain('upload-to-cloud');
    expect(reorderedNames).toContain('validate-format');
    expect(reorderedNames).toContain('compress-file');

    // Strategy decision event should have been emitted
    expect(strategyEvents).toHaveLength(1);
    expect(strategyEvents[0].strategy).toBe('agent-selection');
  });
});
