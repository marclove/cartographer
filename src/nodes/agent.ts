import { query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';
import { BaseNode } from './base.js';
import { NodeStatus } from '../types.js';
import type { AgentNodeConfig, TreeContext } from '../types.js';
import { createBlackboardMcpServer } from '../agent/blackboard-mcp.js';

export class AgentNode extends BaseNode {
  private config: AgentNodeConfig;
  private cachedStatus: NodeStatus | null = null;

  constructor(config: AgentNodeConfig) {
    super(config.name);
    this.config = config;
  }

  reset(): void {
    this.cachedStatus = null;
  }

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    if (this.config.cache && this.cachedStatus !== null) {
      return this.cachedStatus;
    }

    const prompt = typeof this.config.prompt === 'function'
      ? this.config.prompt(context)
      : this.config.prompt;

    context.events.emit('agent:prompt', {
      node: this,
      prompt,
      mode: this.config.mode,
    });

    const status = this.config.mode === 'structured'
      ? await this.executeStructured(prompt, context)
      : await this.executeAgentic(prompt, context);

    if (this.config.cache) {
      this.cachedStatus = status;
    }

    return status;
  }

  private async executeStructured(prompt: string, context: TreeContext): Promise<NodeStatus> {
    const blackboardServer = createBlackboardMcpServer(
      context.blackboard,
      this.config.blackboardNamespace,
    );

    const options: Record<string, unknown> = {
      mcpServers: { blackboard: blackboardServer },
      allowedTools: ['mcp__blackboard__*'],
      model: this.config.model,
      effort: this.config.effort ?? 'low',
      maxTurns: 1,
    };

    if (this.config.outputSchema) {
      options.outputFormat = {
        type: 'json_schema',
        schema: z.toJSONSchema(this.config.outputSchema),
      };
    }

    for await (const message of query({ prompt, options } as any)) {
      const msg = message as any;

      if (msg.type === 'result') {
        if (msg.subtype === 'success') {
          const output = msg.structured_output ?? msg.result;

          context.events.emit('agent:response', {
            node: this,
            result: output,
            cost: msg.total_cost_usd,
          });

          if (output !== undefined) {
            context.blackboard.set(`${this.name}:output`, output);
          }

          if (this.config.mapResult) {
            return this.config.mapResult(output, context);
          }

          return NodeStatus.SUCCESS;
        }

        return NodeStatus.FAILURE;
      }
    }

    return NodeStatus.FAILURE;
  }

  private async executeAgentic(prompt: string, context: TreeContext): Promise<NodeStatus> {
    const blackboardServer = createBlackboardMcpServer(
      context.blackboard,
      this.config.blackboardNamespace,
    );

    const mcpServers: Record<string, unknown> = {
      blackboard: blackboardServer,
      ...this.config.mcpServers,
    };

    const allowedTools = [
      ...(this.config.allowedTools ?? []),
      'mcp__blackboard__*',
    ];

    const options: Record<string, unknown> = {
      mcpServers,
      allowedTools,
      permissionMode: this.config.permissionMode ?? 'default',
      model: this.config.model,
      effort: this.config.effort ?? 'high',
      maxTurns: this.config.maxTurns,
      maxBudgetUsd: this.config.maxBudgetUsd,
      systemPrompt: this.config.systemPrompt,
    };

    for await (const message of query({ prompt, options } as any)) {
      const msg = message as any;

      if (msg.type === 'assistant' && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'tool_use') {
            context.events.emit('agent:tool_use', {
              node: this,
              tool: block.name,
              input: block.input,
            });
          }
        }
      }

      if (msg.type === 'result') {
        const result = msg.result;
        const cost = msg.total_cost_usd;

        context.events.emit('agent:response', {
          node: this,
          result,
          cost,
        });

        if (result !== undefined) {
          context.blackboard.set(`${this.name}:output`, result);
        }

        return msg.subtype === 'success' ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
      }
    }

    return NodeStatus.FAILURE;
  }
}
