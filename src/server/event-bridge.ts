import type { BehaviorTree } from '../core/behavior-tree.js';
import type { TreeEvents } from '../types.js';
import type { StateStore, TreeEvent } from '../state/state-store.js';
import { serializeEvent } from './serializers.js';

function generateEventId(): string {
  return `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function generateMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

interface BufferedEvent {
  type: string;
  data: Record<string, unknown>;
}

export class EventBridge {
  readonly messageId: string;
  private buffer: BufferedEvent[] = [];

  constructor(
    private stateStore: StateStore,
    private stateKey: string,
    messageId?: string,
  ) {
    this.messageId = messageId ?? generateMessageId();
  }

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
  async emitProcessed(treeStatus: string): Promise<void> {
    await this.flush();
    await this.stateStore.appendEvents(this.stateKey, [{
      id: generateEventId(),
      type: 'message:processed',
      data: { messageId: this.messageId, treeStatus },
      timestamp: Date.now(),
    }]);
  }

  /** Flush buffered tree events + emit message:interrupted. */
  async emitInterrupted(): Promise<void> {
    await this.flush();
    await this.stateStore.appendEvents(this.stateKey, [{
      id: generateEventId(),
      type: 'message:interrupted',
      data: { messageId: this.messageId },
      timestamp: Date.now(),
    }]);
  }

  /** Flush buffered tree events + emit message:failed. */
  async emitFailed(error: string): Promise<void> {
    await this.flush();
    await this.stateStore.appendEvents(this.stateKey, [{
      id: generateEventId(),
      type: 'message:failed',
      data: { messageId: this.messageId, error },
      timestamp: Date.now(),
    }]);
  }

  /** Convert buffered events to TreeEvents, append to state store, clear buffer. */
  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const events: TreeEvent[] = this.buffer.map((e) => ({
      id: generateEventId(),
      type: e.type,
      data: e.data,
      timestamp: Date.now(),
    }));
    this.buffer = [];
    await this.stateStore.appendEvents(this.stateKey, events);
  }
}
