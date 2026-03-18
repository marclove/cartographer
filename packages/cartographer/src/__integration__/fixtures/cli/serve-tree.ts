import { BehaviorTree, ActionNode, NodeStatus } from '../../../index.js';
import type { RunContext, TreeRunConfig } from '../../../cli/types.js';

export default function (_ctx: RunContext): TreeRunConfig {
  return {
    tree: new BehaviorTree({
      name: 'serve-test',
      root: new ActionNode({
        name: 'succeed',
        action: () => NodeStatus.SUCCESS,
      }),
    }),
  };
}
