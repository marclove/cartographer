import { ActionNode } from './action.js';
import { NodeStatus } from '../types.js';
import type { TreeContext } from '../types.js';
import { computeContentHash } from '../core/content-hash.js';

/**
 * Notifies the client with structured data via dual write:
 * 1. Blackboard entry at `clientEvents:<name>` (durable)
 * 2. `client:event` event (real-time SSE)
 */
export class NotifyNode extends ActionNode {
  private readonly eventName: string;

  constructor(eventName: string, dataFn: (ctx: TreeContext) => unknown) {
    super({
      name: `notify:${eventName}`,
      action: async (ctx: TreeContext) => {
        const data = dataFn(ctx);
        ctx.blackboard.set(`clientEvents:${eventName}`, data);
        ctx.events.emit('client:event', { name: eventName, data });
        return NodeStatus.SUCCESS;
      },
    });
    this.eventName = eventName;
  }

  protected override computeHash(): string {
    return computeContentHash('NotifyNode', this.eventName);
  }
}

/** Factory function. */
export function notify(
  name: string,
  dataFn: (ctx: TreeContext) => unknown,
): NotifyNode {
  return new NotifyNode(name, dataFn);
}
