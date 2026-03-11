import { describe, it, expect, afterEach } from 'vitest';
import { z } from 'zod/v4';
import { NodeStatus } from '../../types.js';
import { AgentNode } from '../../nodes/agent.js';
import { TreeBuilder } from '../../builder/tree-builder.js';
import { createContext, collectEvents } from '../helpers.js';
import { createTreeLogger } from '../../tree-logger.js';

const LOG_FILE = 'logs/live-agent-structured-mode.log';

let stopLogging: (() => void) | undefined;
afterEach(() => { stopLogging?.(); stopLogging = undefined; });

describe('Agent Structured Mode Integration', { timeout: 30_000 }, () => {
  it('structured mode: classify sentiment with Zod schema', async () => {
    const SentimentSchema = z.object({
      sentiment: z.enum(['positive', 'negative', 'neutral']),
      confidence: z.number().min(0).max(1),
    });

    const agent = new AgentNode({
      name: 'sentiment-classifier',
      prompt: 'Classify the sentiment of: "I absolutely love this product, it changed my life!"',
      outputSchema: SentimentSchema,
      model: 'haiku',
      effort: 'low',
    });

    const ctx = createContext();
    stopLogging = createTreeLogger(ctx.events, { filePath: LOG_FILE, logBlackboard: true });
    const responseEvents = collectEvents(ctx, 'agent:response');

    const status = await agent.tick(ctx);

    expect(status).toBe(NodeStatus.SUCCESS);

    const output = ctx.blackboard.get<z.infer<typeof SentimentSchema>>('sentiment-classifier:output');
    expect(output).toBeDefined();
    expect(['positive', 'negative', 'neutral']).toContain(output!.sentiment);
    expect(output!.confidence).toBeGreaterThanOrEqual(0);
    expect(output!.confidence).toBeLessThanOrEqual(1);

    expect(responseEvents).toHaveLength(1);
    expect(responseEvents[0].result).toBeDefined();
  });

  it('structured mode in a tree with blackboard data flow', async () => {
    const SummarySchema = z.object({
      summary: z.string(),
      wordCount: z.number(),
    });

    const tree = new TreeBuilder('agent-pipeline')
      .sequence('main', (b) => {
        b.action('write-text', (ctx) => {
          ctx.blackboard.set('input-text', 'The quick brown fox jumps over the lazy dog. This classic pangram has been used for decades in typing tests.');
          return NodeStatus.SUCCESS;
        });
        b.agent('summarizer', {
          prompt: (ctx) => {
            const text = ctx.blackboard.get<string>('input-text');
            return `Summarize this text in one short sentence and count the words in the original text: "${text}"`;
          },
          outputSchema: SummarySchema,
          model: 'haiku',
          effort: 'low',
        });
        b.condition('check-result', (ctx) => {
          const output = ctx.blackboard.get<z.infer<typeof SummarySchema>>('summarizer:output');
          return output !== undefined && output.summary.length > 0 && output.wordCount > 0;
        });
      })
      .build();
    stopLogging = createTreeLogger(tree.events, { filePath: LOG_FILE, logBlackboard: true });

    const { status } = await tree.run();
    expect(status).toBe(NodeStatus.SUCCESS);

    const output = tree.blackboard.get<z.infer<typeof SummarySchema>>('summarizer:output');
    expect(output).toBeDefined();
    expect(output!.summary.length).toBeGreaterThan(0);
    expect(output!.wordCount).toBeGreaterThan(0);
  });
});
