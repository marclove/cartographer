import { BehaviorTree, ActionNode, NodeStatus } from '../../../index.js';
import type { RunContext, TreeRunConfig } from '../../../cli/types.js';

export default function (ctx: RunContext): TreeRunConfig {
  return {
    tree: new BehaviorTree({
      name: 'env-test',
      root: new ActionNode({
        name: 'check-env',
        action: (treeCtx) => {
          const val = ctx.env['TEST_VAR'];
          if (val) {
            treeCtx.blackboard.set('env_result', val);
            console.log(`ENV:${val}`);
            return NodeStatus.SUCCESS;
          }
          return NodeStatus.FAILURE;
        },
      }),
    }),
    sessionId: 'default',
  };
}
