import { NodeStatus } from '../types.js';
import type { BehaviorTreeConfig, BTreeNode, Blackboard, TreeContext, TreeEvents } from '../types.js';
import { EventEmitter } from './event-emitter.js';
import { MapBlackboard } from './blackboard.js';

export class BehaviorTree {
  readonly name: string;
  readonly blackboard: Blackboard & { toRecord?(): Record<string, unknown> };
  readonly events: EventEmitter<TreeEvents>;

  private root: BTreeNode;
  private abortController: AbortController;

  constructor(config: BehaviorTreeConfig) {
    this.name = config.name;
    this.root = config.root;
    this.blackboard = config.blackboard ?? new MapBlackboard();
    this.events = new EventEmitter<TreeEvents>();
    this.abortController = new AbortController();
  }

  async tick(): Promise<NodeStatus> {
    const context: TreeContext = {
      blackboard: this.blackboard,
      events: this.events,
      signal: this.abortController.signal,
    };

    return this.root.tick(context);
  }

  async run(): Promise<{ status: NodeStatus; blackboard: Record<string, unknown> }> {
    const status = await this.tick();
    const snapshot =
      'toRecord' in this.blackboard && typeof this.blackboard.toRecord === 'function'
        ? this.blackboard.toRecord()
        : {};
    return { status, blackboard: snapshot };
  }

  reset(): void {
    this.root.reset();
    this.abortController = new AbortController();
  }

  abort(): void {
    this.root.abort();
    this.abortController.abort();
  }
}
