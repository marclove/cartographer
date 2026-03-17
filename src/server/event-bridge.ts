import type { BehaviorTree } from '../core/behavior-tree.js';
import type { TreeEvents } from '../types.js';
import type { StateStore, TreeEvent } from '../state/state-store.js';
import { serializeEvent } from './serializers.js';
import { generateMessageId } from '../actor/types.js';

interface BufferedEvent {
  type: string;
  data: Record<string, unknown>;
}

export class EventBridge {
  private buffer: BufferedEvent[] = [];

  constructor(
    private stateStore: StateStore,
    private stateKey: string,
  ) {}

  /** Subscribe to all tree events. Call before processing. */
  bridgeTree(tree: BehaviorTree): void {
    tree.events.onAny((type, data) => {
      this.buffer.push({
        type,
        data: serializeEvent(type as keyof TreeEvents, data as any),
      });
    });
  }

  /** Flush buffered tree events + emit message:processed. */
  async emitProcessed(messageId: string, treeStatus: string): Promise<void> {
    await this.flush();
    await this.stateStore.appendEvents(this.stateKey, [{
      id: generateMessageId(),
      type: 'message:processed',
      data: { messageId, treeStatus },
      timestamp: Date.now(),
    }]);
  }

  /** Flush buffered tree events + emit message:interrupted. */
  async emitInterrupted(messageId: string): Promise<void> {
    await this.flush();
    await this.stateStore.appendEvents(this.stateKey, [{
      id: generateMessageId(),
      type: 'message:interrupted',
      data: { messageId },
      timestamp: Date.now(),
    }]);
  }

  /** Flush buffered tree events + emit message:failed. */
  async emitFailed(messageId: string, error: string): Promise<void> {
    await this.flush();
    await this.stateStore.appendEvents(this.stateKey, [{
      id: generateMessageId(),
      type: 'message:failed',
      data: { messageId, error },
      timestamp: Date.now(),
    }]);
  }

  /** Convert buffered events to TreeEvents, append to state store, clear buffer. */
  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const events: TreeEvent[] = this.buffer.map((e) => ({
      id: generateMessageId(),
      type: e.type,
      data: e.data,
      timestamp: Date.now(),
    }));
    this.buffer = [];
    await this.stateStore.appendEvents(this.stateKey, events);
  }
}
