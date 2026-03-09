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
import { NodeStatus } from '../types.js';
import type {
  BTreeNode, TreeContext, SelectionStrategy, ExecutionStrategy, ParallelStrategy,
  AgentNodeConfig,
} from '../types.js';

type ActionFn = (context: TreeContext) => Promise<NodeStatus> | NodeStatus;
type ConditionFn = (context: TreeContext) => Promise<boolean> | boolean;

export class CompositeBuilder {
  private children: BTreeNode[] = [];

  action(name: string, fn: ActionFn): this {
    this.children.push(new ActionNode({ name, action: fn }));
    return this;
  }

  condition(name: string, fn: ConditionFn): this {
    this.children.push(new ConditionNode({ name, condition: fn }));
    return this;
  }

  agent(name: string, config: Omit<AgentNodeConfig, 'name'>): this {
    this.children.push(new AgentNode({ name, ...config }));
    return this;
  }

  selector(name: string, optionsOrConfigure?: { strategy?: SelectionStrategy } | ((b: CompositeBuilder) => void), configure?: (b: CompositeBuilder) => void): this {
    const { strategy, configureFn } = parseCompositeArgs(optionsOrConfigure, configure);
    const builder = new CompositeBuilder();
    configureFn?.(builder);
    this.children.push(new SelectorNode({ name, children: builder.getChildren(), strategy: strategy as SelectionStrategy | undefined }));
    return this;
  }

  sequence(name: string, optionsOrConfigure?: { strategy?: ExecutionStrategy } | ((b: CompositeBuilder) => void), configure?: (b: CompositeBuilder) => void): this {
    const { strategy, configureFn } = parseCompositeArgs(optionsOrConfigure, configure);
    const builder = new CompositeBuilder();
    configureFn?.(builder);
    this.children.push(new SequenceNode({ name, children: builder.getChildren(), strategy: strategy as ExecutionStrategy | undefined }));
    return this;
  }

  parallel(name: string, optionsOrConfigure?: { strategy?: ParallelStrategy } | ((b: CompositeBuilder) => void), configure?: (b: CompositeBuilder) => void): this {
    const { strategy, configureFn } = parseCompositeArgs(optionsOrConfigure, configure);
    const builder = new CompositeBuilder();
    configureFn?.(builder);
    this.children.push(new ParallelNode({ name, children: builder.getChildren(), strategy: strategy as ParallelStrategy | undefined }));
    return this;
  }

  inverter(name: string, configure: (b: SingleChildBuilder) => void): this {
    const builder = new SingleChildBuilder();
    configure(builder);
    this.children.push(new InverterNode({ name, child: builder.getChild() }));
    return this;
  }

  repeat(name: string, options: { count?: number; untilStatus?: NodeStatus }, configure: (b: SingleChildBuilder) => void): this {
    const builder = new SingleChildBuilder();
    configure(builder);
    this.children.push(new RepeatNode({ name, child: builder.getChild(), ...options }));
    return this;
  }

  retry(name: string, options: { maxAttempts: number; delayMs?: number }, configure: (b: SingleChildBuilder) => void): this {
    const builder = new SingleChildBuilder();
    configure(builder);
    this.children.push(new RetryNode({ name, child: builder.getChild(), ...options }));
    return this;
  }

  alwaysSucceed(name: string, configure: (b: SingleChildBuilder) => void): this {
    const builder = new SingleChildBuilder();
    configure(builder);
    this.children.push(new AlwaysSucceedNode({ name, child: builder.getChild() }));
    return this;
  }

  alwaysFail(name: string, configure: (b: SingleChildBuilder) => void): this {
    const builder = new SingleChildBuilder();
    configure(builder);
    this.children.push(new AlwaysFailNode({ name, child: builder.getChild() }));
    return this;
  }

  timeout(name: string, options: { timeoutMs: number }, configure: (b: SingleChildBuilder) => void): this {
    const builder = new SingleChildBuilder();
    configure(builder);
    this.children.push(new TimeoutNode({ name, child: builder.getChild(), ...options }));
    return this;
  }

  guard(name: string, options: { condition: ConditionFn }, configure: (b: SingleChildBuilder) => void): this {
    const builder = new SingleChildBuilder();
    configure(builder);
    this.children.push(new GuardNode({ name, child: builder.getChild(), condition: options.condition }));
    return this;
  }

  getChildren(): BTreeNode[] {
    return [...this.children];
  }
}

export class SingleChildBuilder {
  private child: BTreeNode | null = null;

  action(name: string, fn: ActionFn): this {
    this.child = new ActionNode({ name, action: fn });
    return this;
  }

  condition(name: string, fn: ConditionFn): this {
    this.child = new ConditionNode({ name, condition: fn });
    return this;
  }

  agent(name: string, config: Omit<AgentNodeConfig, 'name'>): this {
    this.child = new AgentNode({ name, ...config });
    return this;
  }

  selector(name: string, optionsOrConfigure?: { strategy?: SelectionStrategy } | ((b: CompositeBuilder) => void), configure?: (b: CompositeBuilder) => void): this {
    const { strategy, configureFn } = parseCompositeArgs(optionsOrConfigure, configure);
    const builder = new CompositeBuilder();
    configureFn?.(builder);
    this.child = new SelectorNode({ name, children: builder.getChildren(), strategy: strategy as SelectionStrategy | undefined });
    return this;
  }

  sequence(name: string, optionsOrConfigure?: { strategy?: ExecutionStrategy } | ((b: CompositeBuilder) => void), configure?: (b: CompositeBuilder) => void): this {
    const { strategy, configureFn } = parseCompositeArgs(optionsOrConfigure, configure);
    const builder = new CompositeBuilder();
    configureFn?.(builder);
    this.child = new SequenceNode({ name, children: builder.getChildren(), strategy: strategy as ExecutionStrategy | undefined });
    return this;
  }

  parallel(name: string, optionsOrConfigure?: { strategy?: ParallelStrategy } | ((b: CompositeBuilder) => void), configure?: (b: CompositeBuilder) => void): this {
    const { strategy, configureFn } = parseCompositeArgs(optionsOrConfigure, configure);
    const builder = new CompositeBuilder();
    configureFn?.(builder);
    this.child = new ParallelNode({ name, children: builder.getChildren(), strategy: strategy as ParallelStrategy | undefined });
    return this;
  }

  inverter(name: string, configure: (b: SingleChildBuilder) => void): this {
    const builder = new SingleChildBuilder();
    configure(builder);
    this.child = new InverterNode({ name, child: builder.getChild() });
    return this;
  }

  repeat(name: string, options: { count?: number; untilStatus?: NodeStatus }, configure: (b: SingleChildBuilder) => void): this {
    const builder = new SingleChildBuilder();
    configure(builder);
    this.child = new RepeatNode({ name, child: builder.getChild(), ...options });
    return this;
  }

  retry(name: string, options: { maxAttempts: number; delayMs?: number }, configure: (b: SingleChildBuilder) => void): this {
    const builder = new SingleChildBuilder();
    configure(builder);
    this.child = new RetryNode({ name, child: builder.getChild(), ...options });
    return this;
  }

  alwaysSucceed(name: string, configure: (b: SingleChildBuilder) => void): this {
    const builder = new SingleChildBuilder();
    configure(builder);
    this.child = new AlwaysSucceedNode({ name, child: builder.getChild() });
    return this;
  }

  alwaysFail(name: string, configure: (b: SingleChildBuilder) => void): this {
    const builder = new SingleChildBuilder();
    configure(builder);
    this.child = new AlwaysFailNode({ name, child: builder.getChild() });
    return this;
  }

  timeout(name: string, options: { timeoutMs: number }, configure: (b: SingleChildBuilder) => void): this {
    const builder = new SingleChildBuilder();
    configure(builder);
    this.child = new TimeoutNode({ name, child: builder.getChild(), ...options });
    return this;
  }

  guard(name: string, options: { condition: ConditionFn }, configure: (b: SingleChildBuilder) => void): this {
    const builder = new SingleChildBuilder();
    configure(builder);
    this.child = new GuardNode({ name, child: builder.getChild(), condition: options.condition });
    return this;
  }

  getChild(): BTreeNode {
    if (!this.child) {
      throw new Error('Decorator must have exactly one child node');
    }
    return this.child;
  }
}

function parseCompositeArgs(
  optionsOrConfigure?: Record<string, unknown> | ((b: CompositeBuilder) => void),
  configure?: (b: CompositeBuilder) => void,
): { strategy?: unknown; configureFn?: (b: CompositeBuilder) => void } {
  if (typeof optionsOrConfigure === 'function') {
    return { configureFn: optionsOrConfigure };
  }
  return {
    strategy: optionsOrConfigure?.strategy,
    configureFn: configure,
  };
}

export class TreeBuilder extends CompositeBuilder {
  private treeName: string;

  constructor(name: string) {
    super();
    this.treeName = name;
  }

  build(): BehaviorTree {
    const children = this.getChildren();
    if (children.length !== 1) {
      throw new Error(`Tree must have exactly one root node, got ${children.length}`);
    }
    return new BehaviorTree({ name: this.treeName, root: children[0] });
  }
}
