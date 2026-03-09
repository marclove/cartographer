import YAML from 'yaml';
import { BehaviorTree } from '../core/behavior-tree.js';
import { ActionNode } from '../nodes/action.js';
import { ConditionNode } from '../nodes/condition.js';
import { AgentNode } from '../nodes/agent.js';
import { SelectorNode } from '../composites/selector.js';
import { SequenceNode } from '../composites/sequence.js';
import { ParallelNode } from '../composites/parallel.js';
import { InverterNode } from '../decorators/inverter.js';
import { RepeatNode } from '../decorators/repeat.js';
import { RetryNode } from '../decorators/retry.js';
import { AlwaysSucceedNode } from '../decorators/always-succeed.js';
import { AlwaysFailNode } from '../decorators/always-fail.js';
import { TimeoutNode } from '../decorators/timeout.js';
import { GuardNode } from '../decorators/guard.js';
import type { BTreeNode } from '../types.js';
import type { TreeRegistry } from './registry.js';

interface NodeConfig {
  type: string;
  name: string;
  ref?: string;
  children?: NodeConfig[];
  child?: NodeConfig;
  strategy?: { type?: string; ref?: string; prompt?: string; [key: string]: unknown };
  [key: string]: unknown;
}

interface TreeConfig {
  name: string;
  root: NodeConfig;
}

export class TreeLoader {
  static fromYAML(yamlString: string, registry: TreeRegistry): BehaviorTree {
    const config = YAML.parse(yamlString) as TreeConfig;
    return TreeLoader.fromConfig(config, registry);
  }

  static fromConfig(config: TreeConfig, registry: TreeRegistry): BehaviorTree {
    const root = TreeLoader.buildNode(config.root, registry);
    return new BehaviorTree({ name: config.name, root });
  }

  private static buildNode(config: NodeConfig, registry: TreeRegistry): BTreeNode {
    switch (config.type) {
      case 'action':
        return new ActionNode({
          name: config.name,
          action: registry.getAction(config.ref!),
        });

      case 'condition':
        return new ConditionNode({
          name: config.name,
          condition: registry.getCondition(config.ref!),
        });

      case 'agent':
        return new AgentNode({
          name: config.name,
          mode: config.mode as 'structured' | 'agentic',
          prompt: config.prompt as string,
          outputSchema: config.outputSchema
            ? registry.getSchema(config.outputSchema as string)
            : undefined,
          model: config.model as any,
          effort: config.effort as any,
          allowedTools: config.allowedTools as string[] | undefined,
          permissionMode: config.permissionMode as any,
          maxTurns: config.maxTurns as number | undefined,
          maxBudgetUsd: config.maxBudgetUsd as number | undefined,
          systemPrompt: config.systemPrompt as string | undefined,
          blackboardNamespace: config.blackboardNamespace as string | undefined,
        });

      case 'selector':
        return new SelectorNode({
          name: config.name,
          children: (config.children ?? []).map((c) => TreeLoader.buildNode(c, registry)),
          strategy: config.strategy?.ref
            ? (registry.getStrategy(config.strategy.ref) as any)
            : undefined,
        });

      case 'sequence':
        return new SequenceNode({
          name: config.name,
          children: (config.children ?? []).map((c) => TreeLoader.buildNode(c, registry)),
          strategy: config.strategy?.ref
            ? (registry.getStrategy(config.strategy.ref) as any)
            : undefined,
        });

      case 'parallel':
        return new ParallelNode({
          name: config.name,
          children: (config.children ?? []).map((c) => TreeLoader.buildNode(c, registry)),
          strategy: config.strategy?.ref
            ? (registry.getStrategy(config.strategy.ref) as any)
            : undefined,
        });

      case 'inverter':
        return new InverterNode({
          name: config.name,
          child: TreeLoader.buildNode(config.child!, registry),
        });

      case 'repeat':
        return new RepeatNode({
          name: config.name,
          child: TreeLoader.buildNode(config.child!, registry),
          count: config.count as number | undefined,
          untilStatus: config.untilStatus as any,
        });

      case 'retry':
        return new RetryNode({
          name: config.name,
          child: TreeLoader.buildNode(config.child!, registry),
          maxAttempts: config.maxAttempts as number,
          delayMs: config.delayMs as number | undefined,
        });

      case 'alwaysSucceed':
        return new AlwaysSucceedNode({
          name: config.name,
          child: TreeLoader.buildNode(config.child!, registry),
        });

      case 'alwaysFail':
        return new AlwaysFailNode({
          name: config.name,
          child: TreeLoader.buildNode(config.child!, registry),
        });

      case 'timeout':
        return new TimeoutNode({
          name: config.name,
          child: TreeLoader.buildNode(config.child!, registry),
          timeoutMs: config.timeoutMs as number,
        });

      case 'guard':
        return new GuardNode({
          name: config.name,
          child: TreeLoader.buildNode(config.child!, registry),
          condition: registry.getCondition(config.conditionRef as string),
        });

      default:
        throw new Error(`Unknown node type: ${config.type}`);
    }
  }
}
