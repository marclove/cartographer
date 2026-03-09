import { query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';
import type { BTreeNode, TreeContext, AgentStrategyConfig } from '../types.js';

export async function queryStructured<T extends z.ZodType>(
  prompt: string,
  schema: T,
  config: AgentStrategyConfig,
): Promise<z.infer<T> | null> {
  try {
    const { $schema, ...jsonSchema } = z.toJSONSchema(schema) as Record<string, unknown>;
    for await (const message of query({
      prompt,
      options: {
        outputFormat: { type: 'json_schema', schema: jsonSchema },
        model: config.model ?? 'sonnet',
        effort: config.effort ?? 'low',
      },
    } as any)) {
      const msg = message as any;
      if (msg.type === 'result') {
        if (msg.subtype === 'success') {
          if (msg.structured_output) {
            return msg.structured_output as z.infer<T>;
          }
          if (typeof msg.result === 'string') {
            try {
              return JSON.parse(msg.result) as z.infer<T>;
            } catch {
              return null;
            }
          }
        }
        return null;
      }
    }
  } catch {
    return null;
  }

  return null;
}

export function buildStrategyPrompt(
  config: AgentStrategyConfig,
  children: BTreeNode[],
  context: TreeContext,
): string {
  const basePrompt = typeof config.prompt === 'function'
    ? config.prompt(children, context)
    : config.prompt;

  const childInfo = children.map((c) => ({
    name: c.name,
    description: config.childDescriptions?.[c.name] ?? c.name,
  }));

  const blackboardState: Record<string, unknown> = {};
  for (const key of context.blackboard.keys()) {
    blackboardState[key] = context.blackboard.get(key);
  }

  return `${basePrompt}\n\nAvailable children:\n${JSON.stringify(childInfo, null, 2)}\n\nBlackboard state:\n${JSON.stringify(blackboardState, null, 2)}`;
}
