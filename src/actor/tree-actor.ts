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
  interrupted?: boolean;
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
  private interruptController: AbortController | null = null;

  constructor(options: TreeActorOptions) {
    this.createTree = options.createTree;
    this.stateStore = options.stateStore;
    this.stateKey = options.stateKey;
    this.topologyPolicy = options.topologyPolicy ?? 'fail';
  }

  /** Signal the in-progress processing loop to interrupt. Safe to call at any time. */
  requestInterrupt(): void {
    this.interruptController?.abort();
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

    // Run to completion (or until interrupted)
    this.interruptController = new AbortController();
    let interrupted = false;
    let treeStatus: NodeStatus;
    try {
      treeStatus = await this.runToCompletion(tree);
    } catch (e) {
      if ((e as Error).message === 'interrupted') {
        tree.interrupt();
        treeStatus = NodeStatus.RUNNING;
        interrupted = true;
      } else {
        throw e;
      }
    } finally {
      this.interruptController = null;
    }

    // Serialize and save
    const blackboardSnapshot = this.serializeBlackboard(tree);
    const treeState = serializeTree(tree.root, tree.rootHash);
    await this.stateStore.saveState(this.stateKey, {
      blackboard: blackboardSnapshot,
      treeState,
      createdAt: stored?.createdAt ?? Date.now(),
      lastMessageAt: Date.now(),
      ...(interrupted && { held: true }),
    });

    return { treeStatus, ...(interrupted && { interrupted: true }) };
  }

  private async runToCompletion(tree: BehaviorTree): Promise<NodeStatus> {
    let consecutiveNoInflight = 0;
    while (true) {
      const status = await tree.tick();
      if (status !== NodeStatus.RUNNING) return status;

      if (tree.hasInflightWork()) {
        // Race: wait for inflight work to settle, or for an interrupt signal
        const interrupted = await this.raceSettledOrInterrupt(tree);
        if (interrupted) {
          throw new Error('interrupted');
        }
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

  /**
   * Race tree.settled() against the interrupt signal.
   * Returns true if interrupted, false if settled normally.
   */
  private raceSettledOrInterrupt(tree: BehaviorTree): Promise<boolean> {
    const signal = this.interruptController?.signal;
    if (!signal) return tree.settled().then(() => false);
    if (signal.aborted) return Promise.resolve(true);

    return new Promise<boolean>((resolve) => {
      let resolved = false;
      const onInterrupt = () => {
        if (!resolved) { resolved = true; resolve(true); }
      };
      signal.addEventListener('abort', onInterrupt, { once: true });
      tree.settled().then(() => {
        if (!resolved) {
          resolved = true;
          signal.removeEventListener('abort', onInterrupt);
          resolve(false);
        }
      });
    });
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
