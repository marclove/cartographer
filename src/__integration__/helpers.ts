import { MapBlackboard } from '../core/blackboard.js';
import { EventEmitter } from '../core/event-emitter.js';
import { NodeStatus } from '../types.js';
import type { TreeContext, TreeEvents } from '../types.js';

export function createContext(initial?: Record<string, unknown>): TreeContext {
  return {
    blackboard: new MapBlackboard(initial),
    events: new EventEmitter<TreeEvents>(),
  };
}

export function sequentialAction(name: string, statuses: NodeStatus[]) {
  let tick = 0;
  return {
    name,
    action: () => {
      const status = statuses[Math.min(tick, statuses.length - 1)];
      tick++;
      return status;
    },
  };
}

export function blackboardWriter(name: string, key: string, value: unknown) {
  return {
    name,
    action: (ctx: TreeContext) => {
      ctx.blackboard.set(key, value);
      return NodeStatus.SUCCESS;
    },
  };
}

export function slowAction(name: string, delayMs: number, status: NodeStatus) {
  return {
    name,
    action: () =>
      new Promise<NodeStatus>((resolve) => setTimeout(() => resolve(status), delayMs)),
  };
}

export function collectEvents<K extends keyof TreeEvents & string>(
  ctx: TreeContext,
  eventName: K,
): TreeEvents[K][] {
  const collected: TreeEvents[K][] = [];
  ctx.events.on(eventName, (data) => collected.push(data));
  return collected;
}
