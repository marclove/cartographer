import { BehaviorTree } from '../core/behavior-tree.js';
import { NodeStatus } from '../types.js';
import { serializeTree, restoreTree } from '../core/serialization.js';
import type { StateStore } from '../state/state-store.js';
import type { ActorMessage } from './types.js';

export interface TreeActorOptions {
  createTree: () => BehaviorTree;
  stateStore: StateStore;
  stateKey: string;
  topologyPolicy?: 'fail' | 'reset';
}

export interface ProcessResult {
  treeStatus: NodeStatus | 'error';
  error?: string;
}

/**
 * Transient per-message processor. Created per request, processes one message,
 * then discarded. Encapsulates the full processing pipeline:
 * load state → hydrate tree → apply message → runToCompletion → serialize → save.
 */
export class TreeActor {
  private createTree: () => BehaviorTree;
  private stateStore: StateStore;
  private stateKey: string;
  private topologyPolicy: 'fail' | 'reset';

  constructor(options: TreeActorOptions) {
    this.createTree = options.createTree;
    this.stateStore = options.stateStore;
    this.stateKey = options.stateKey;
    this.topologyPolicy = options.topologyPolicy ?? 'fail';
  }

  async process(msg: ActorMessage): Promise<ProcessResult> {
    const tree = this.createTree();

    // Load and restore state
    const stored = await this.stateStore.getState(this.stateKey);
    if (stored) {
      for (const [key, value] of Object.entries(stored.blackboard)) {
        tree.blackboard.set(key, value);
      }
      restoreTree(tree.root, tree.rootHash, stored.treeState, this.topologyPolicy);
    }

    // Apply message
    if (msg.type === 'action') {
      tree.blackboard.set(`actions:${msg.name}`, msg.payload ?? {});
    } else if (msg.type === 'write') {
      tree.blackboard.set(msg.key, msg.value);
    } else if (msg.type === 'signal') {
      return this.handleSignal(tree, msg.signal);
    }

    // Run to completion
    const treeStatus = await this.runToCompletion(tree);

    // Serialize and save
    const blackboardSnapshot = this.serializeBlackboard(tree);
    const treeState = serializeTree(tree.root, tree.rootHash);
    await this.stateStore.saveState(this.stateKey, {
      blackboard: blackboardSnapshot,
      treeState,
      createdAt: stored?.createdAt ?? Date.now(),
      lastMessageAt: Date.now(),
    });

    return { treeStatus };
  }

  private async runToCompletion(tree: BehaviorTree): Promise<NodeStatus> {
    let consecutiveNoInflight = 0;
    while (true) {
      const status = await tree.tick();
      if (status !== NodeStatus.RUNNING) return status;

      if (tree.hasInflightWork()) {
        await tree.settled();
        consecutiveNoInflight = 0;
        continue;
      }

      // RUNNING with no inflight work: either a fast action completed during
      // the tick (result pending collection) or the tree is truly suspended.
      // Tick once more to distinguish — if still RUNNING with no inflight,
      // the tree is suspended.
      consecutiveNoInflight++;
      if (consecutiveNoInflight >= 2) return status;
    }
  }

  private handleSignal(tree: BehaviorTree, signal: string): ProcessResult {
    if (signal === 'reset') tree.reset();
    if (signal === 'abort') tree.abort();
    return { treeStatus: 'error', error: `Signal handled: ${signal}` };
  }

  private serializeBlackboard(tree: BehaviorTree): Record<string, unknown> {
    if ('toRecord' in tree.blackboard && typeof tree.blackboard.toRecord === 'function') {
      return tree.blackboard.toRecord();
    }
    const result: Record<string, unknown> = {};
    for (const key of tree.blackboard.keys()) {
      result[key] = tree.blackboard.get(key);
    }
    return result;
  }
}
