import { z } from 'zod/v4';
import type { ParallelStrategy, ParallelPolicy, BTreeNode, TreeContext, AgentStrategyConfig } from '../types.js';
import { buildStrategyPrompt } from '../agent/sdk-helpers.js';
import type { AgentMessage } from '../agent/agent.js';

/**
 * The schema the agent must conform to when returning a policy decision.
 * `policy` maps to the {@link ParallelPolicy} fields the `ParallelNode` evaluates.
 * `reasoning` is a brief explanation logged via the `strategy:decision` event.
 */
const PolicySchema = z.object({
  policy: z.object({
    successCount: z.number().optional(),
    successPercentage: z.number().optional(),
    failureCount: z.number().optional(),
  }).describe('The parallel execution policy'),
  reasoning: z.string().describe('Brief explanation of the policy decision'),
});

/**
 * A {@link ParallelStrategy} that asks an Agent to decide the success/failure
 * policy for a {@link ParallelNode} at runtime.
 *
 * If the agent call fails, the strategy falls back to the safest default:
 * requiring *all* children to succeed (`{ successCount: children.length }`).
 */
export class AgentParallelStrategy implements ParallelStrategy {
  private cachedPolicy: ParallelPolicy | null = null;

  constructor(private config: AgentStrategyConfig) {}

  reset(): void {
    this.cachedPolicy = null;
  }

  async policy(children: BTreeNode[], context: TreeContext): Promise<ParallelPolicy> {
    if (this.config.cache && this.cachedPolicy !== null) {
      return this.cachedPolicy;
    }

    const prompt = buildStrategyPrompt(this.config, children, context);
    const nodeProxy = children[0] ?? ({ id: '', name: '' } as any);
    context.events.emit('agent:prompt', { node: nodeProxy, prompt });

    const { $schema, ...jsonSchema } = z.toJSONSchema(PolicySchema) as Record<string, unknown>;

    let result: z.infer<typeof PolicySchema> | null = null;

    try {
      for await (const msg of this.config.agent.send(prompt, {
        signal: context.signal,
        onMessage: (msg: AgentMessage) => this.emitAgentEvent(msg, nodeProxy, context),
        outputSchema: jsonSchema,
        onElicitation: context.onElicitation,
      })) {
        if (msg.type === 'result') {
          if (msg.subtype === 'success') {
            result = msg.output as z.infer<typeof PolicySchema>;
          }
        }
      }
    } catch {
      return { successCount: children.length };
    }

    if (!result) {
      return { successCount: children.length };
    }

    context.events.emit('strategy:decision', {
      composite: children[0] ?? ({ id: '', name: '' } as any),
      strategy: 'agent-parallel',
      decision: result,
    });

    if (this.config.cache) this.cachedPolicy = result.policy;
    return result.policy;
  }

  private emitAgentEvent(msg: AgentMessage, node: BTreeNode, context: TreeContext): void {
    switch (msg.type) {
      case 'thinking':
        context.events.emit('agent:thinking', { node, thinking: msg.content });
        break;
      case 'text':
        context.events.emit('agent:text', { node, text: msg.content });
        break;
      case 'tool_use':
        context.events.emit('agent:tool_use', { node, tool: msg.name, input: msg.input });
        break;
      case 'stream':
        context.events.emit('agent:stream', { node, event: msg.event });
        break;
      case 'result':
        if (msg.subtype === 'success') {
          context.events.emit('agent:response', { node, result: msg.output, cost: msg.cost });
        } else {
          (context.events.emit as any)('agent:error', { node, errors: msg.errors, cost: msg.cost });
        }
        break;
      case 'provider_event': {
        const d = msg.data as Record<string, unknown>;
        const eventMap: Record<string, string> = { tool_progress: 'agent:tool_progress', init: 'agent:init', status: 'agent:status', rate_limit: 'agent:rate_limit' };
        const eventName = eventMap[msg.subtype];
        if (eventName) (context.events.emit as any)(eventName, { node, ...d });
        break;
      }
    }
  }
}
