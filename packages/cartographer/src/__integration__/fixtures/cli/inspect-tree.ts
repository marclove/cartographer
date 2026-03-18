import { BehaviorTree, SequenceNode, ActionNode, ConditionNode, RetryNode, NodeStatus } from '../../../index.js';
import type { RunContext, TreeRunConfig } from '../../../cli/types.js';

export default function (_ctx: RunContext): TreeRunConfig {
  return {
    tree: new BehaviorTree({
      name: 'inspect-test',
      root: new SequenceNode({
        name: 'main',
        children: [
          new ConditionNode({ name: 'is-ready', condition: () => true }),
          new RetryNode({
            name: 'with-retry',
            maxAttempts: 3,
            child: new ActionNode({ name: 'do-work', action: () => NodeStatus.SUCCESS }),
          }),
        ],
      }),
    }),
  };
}
