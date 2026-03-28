import { BaseNode } from './base.js';
import { NodeStatus } from '../types.js';
import type { TreeContext, Blackboard } from '../types.js';
import { computeContentHash } from '../core/content-hash.js';

export interface ReceiveOptions<TPayload> {
  mapPayload?: (payload: TPayload, blackboard: Blackboard) => void;
}

/**
 * A synchronous, non-reactive node that receives and consumes an inbound
 * command from the blackboard.
 *
 * Extends BaseNode directly (not ActionNode or ConditionNode) to ensure:
 * - Non-reactive: sequences cache its SUCCESS in completedMap
 * - Synchronous: no _inflightState polling, returns immediately
 *
 * Critical invariant: consume-on-read safety depends on faithful
 * completedMap serialization.
 */
export class ReceiveNode<TPayload> extends BaseNode {
  private readonly commandName: string;
  private readonly mapPayload?: (payload: TPayload, blackboard: Blackboard) => void;

  constructor(commandName: string, options?: ReceiveOptions<TPayload>) {
    super(`receive:${commandName}`);
    this.commandName = commandName;
    this.mapPayload = options?.mapPayload;
  }

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    const key = `commands:${this.commandName}`;
    const payload = context.blackboard.get<TPayload>(key);

    if (payload === undefined) {
      return NodeStatus.FAILURE;
    }

    // Consume the command
    context.blackboard.delete(key);

    if (this.mapPayload) {
      this.mapPayload(payload, context.blackboard);
    }

    return NodeStatus.SUCCESS;
  }

  protected override computeHash(): string {
    return computeContentHash('ReceiveNode', this.commandName);
  }
}

/** Factory function. */
export function receive<TPayload>(name: string, options?: ReceiveOptions<TPayload>): ReceiveNode<TPayload> {
  return new ReceiveNode<TPayload>(name, options);
}
