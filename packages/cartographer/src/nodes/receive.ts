import { BaseNode } from './base.js';
import { NodeStatus } from '../types.js';
import type { TreeContext, Blackboard } from '../types.js';
import { computeContentHash } from '../core/content-hash.js';

export interface ReceiveOptions {
  mapPayload?: (payload: unknown, blackboard: Blackboard) => void;
}

/**
 * A synchronous, non-reactive node that receives and consumes an inbound
 * action from the blackboard.
 *
 * Extends BaseNode directly (not ActionNode or ConditionNode) to ensure:
 * - Non-reactive: sequences cache its SUCCESS in completedMap
 * - Synchronous: no _inflightState polling, returns immediately
 *
 * Critical invariant: consume-on-read safety depends on faithful
 * completedMap serialization.
 */
export class ReceiveNode extends BaseNode {
  private readonly actionName: string;
  private readonly mapPayload?: (payload: unknown, blackboard: Blackboard) => void;

  constructor(actionName: string, options?: ReceiveOptions) {
    super(`receive:${actionName}`);
    this.actionName = actionName;
    this.mapPayload = options?.mapPayload;
  }

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    const key = `actions:${this.actionName}`;
    const payload = context.blackboard.get(key);

    if (payload === undefined) {
      return NodeStatus.FAILURE;
    }

    // Consume the action
    context.blackboard.delete(key);

    if (this.mapPayload) {
      this.mapPayload(payload, context.blackboard);
    }

    return NodeStatus.SUCCESS;
  }

  protected override computeHash(): string {
    return computeContentHash('ReceiveNode', this.actionName);
  }
}

/** Factory function. */
export function receive(name: string, options?: ReceiveOptions): ReceiveNode {
  return new ReceiveNode(name, options);
}
