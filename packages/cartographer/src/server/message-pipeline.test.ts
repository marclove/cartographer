import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMessagePipeline } from './message-pipeline.js';
import type { MessagePipelineHandle } from './message-pipeline.js';
import { BehaviorTree } from '../core/behavior-tree.js';
import { ActionNode } from '../nodes/action.js';
import { NodeStatus } from '../types.js';
import { InMemoryStateStore } from '../state/in-memory-state-store.js';
import { EventBridge } from './event-bridge.js';
import type { ActorMessage } from '../actor/types.js';

function makeTree(): BehaviorTree {
  const action = new ActionNode({
    name: 'noop',
    action: async () => NodeStatus.SUCCESS,
  });
  return new BehaviorTree({ name: 'test-tree', root: action });
}

function makeSlowTree(): BehaviorTree {
  const action = new ActionNode({
    name: 'slow',
    action: async () => {
      await new Promise((r) => setTimeout(r, 50));
      return NodeStatus.SUCCESS;
    },
  });
  return new BehaviorTree({ name: 'slow-tree', root: action });
}

describe('createMessagePipeline', () => {
  let stateStore: InMemoryStateStore;
  let pipeline: MessagePipelineHandle;
  let scheduleStreamEviction: ReturnType<typeof vi.fn>;
  let bridgeMessageIds: Map<string, string>;

  beforeEach(() => {
    stateStore = new InMemoryStateStore();
    scheduleStreamEviction = vi.fn();
    bridgeMessageIds = new Map();

    pipeline = createMessagePipeline({
      createTree: makeTree,
      stateStore,
      topologyPolicy: 'fail',
      maxQueueDepth: 3,
      context: {},
      createBridge: (sessionKey: string, messageId?: string) => {
        const bridge = new EventBridge(stateStore, sessionKey, messageId);
        bridgeMessageIds.set(sessionKey, bridge.messageId);
        return bridge;
      },
      scheduleStreamEviction,
    });
  });

  describe('acquireOrQueue', () => {
    it('returns acquired when lock is available', async () => {
      const msg: ActorMessage = { type: 'tick' };
      const result = await pipeline.acquireOrQueue(msg, 'session-1');

      expect(result.queued).toBe(false);
      if (!result.queued) {
        expect(result.requestId).toMatch(/^req-/);
        expect(result.bridge).toBeInstanceOf(EventBridge);
      }
    });

    it('assigns bridge messageId to msg', async () => {
      const msg: ActorMessage = { type: 'tick' };
      const result = await pipeline.acquireOrQueue(msg, 'session-1');

      expect(msg.id).toBe(result.bridge.messageId);
    });

    it('returns queued with position when lock is held', async () => {
      // Acquire the lock first
      await stateStore.acquireLock('session-1', 'existing-holder', 30000);

      const msg: ActorMessage = { type: 'tick' };
      const result = await pipeline.acquireOrQueue(msg, 'session-1');

      expect(result.queued).toBe(true);
      if (result.queued) {
        expect(result.queueFull).toBe(false);
        expect(result.position).toBe(1);
        expect(result.bridge).toBeInstanceOf(EventBridge);
      }
    });

    it('returns queue full when at max depth', async () => {
      // Acquire lock and fill queue
      await stateStore.acquireLock('session-1', 'existing-holder', 30000);
      await stateStore.enqueueMessage('session-1', { type: 'tick' }, 3);
      await stateStore.enqueueMessage('session-1', { type: 'tick' }, 3);
      await stateStore.enqueueMessage('session-1', { type: 'tick' }, 3);

      const msg: ActorMessage = { type: 'tick' };
      const result = await pipeline.acquireOrQueue(msg, 'session-1');

      expect(result.queued).toBe(true);
      if (result.queued) {
        expect(result.queueFull).toBe(true);
        expect(result.position).toBe(-1);
      }
    });

    it('preserves client-supplied messageId', async () => {
      const msg: ActorMessage = { type: 'tick', id: 'client-id-1' };
      const result = await pipeline.acquireOrQueue(msg, 'session-1', 'client-id-1');

      expect(result.bridge.messageId).toBe('client-id-1');
      expect(msg.id).toBe('client-id-1');
    });
  });

  describe('executeMessage', () => {
    it('cleans up activeProcessors after completion', async () => {
      const msg: ActorMessage = { type: 'tick' };
      const prep = await pipeline.acquireOrQueue(msg, 'session-1');
      if (prep.queued) throw new Error('Expected acquired');

      await pipeline.executeMessage(msg, 'session-1', prep.requestId, prep.bridge);

      expect(pipeline.activeProcessors.has('session-1')).toBe(false);
    });

    it('stores processor in activeProcessors during execution', async () => {
      // Use a slow tree so we can inspect mid-execution
      const slowPipeline = createMessagePipeline({
        createTree: makeSlowTree,
        stateStore,
        topologyPolicy: 'fail',
        maxQueueDepth: 3,
        context: {},
        createBridge: (sessionKey: string, messageId?: string) =>
          new EventBridge(stateStore, sessionKey, messageId),
        scheduleStreamEviction,
      });

      const msg: ActorMessage = { type: 'tick' };
      const acquired = await stateStore.acquireLock('session-2', 'req-1', 30000);
      expect(acquired).toBe(true);
      const bridge = new EventBridge(stateStore, 'session-2');
      msg.id = bridge.messageId;

      const promise = slowPipeline.executeMessage(msg, 'session-2', 'req-1', bridge);

      // Give it a moment to start
      await new Promise((r) => setTimeout(r, 10));
      expect(slowPipeline.activeProcessors.has('session-2')).toBe(true);

      await promise;
      expect(slowPipeline.activeProcessors.has('session-2')).toBe(false);
    });

    it('calls scheduleStreamEviction in finally', async () => {
      const msg: ActorMessage = { type: 'tick' };
      const prep = await pipeline.acquireOrQueue(msg, 'session-1');
      if (prep.queued) throw new Error('Expected acquired');

      await pipeline.executeMessage(msg, 'session-1', prep.requestId, prep.bridge);

      expect(scheduleStreamEviction).toHaveBeenCalledWith('session-1');
    });

    it('releases lock after execution', async () => {
      const msg: ActorMessage = { type: 'tick' };
      const prep = await pipeline.acquireOrQueue(msg, 'session-1');
      if (prep.queued) throw new Error('Expected acquired');

      await pipeline.executeMessage(msg, 'session-1', prep.requestId, prep.bridge);

      // drainQueue fires async in finally — wait for it to finish
      await new Promise((r) => setTimeout(r, 50));

      // Lock should be released — a new acquire should succeed
      const reacquired = await stateStore.acquireLock('session-1', 'new-req', 30000);
      expect(reacquired).toBe(true);
    });

    it('returns failure status when action node throws', async () => {
      const failPipeline = createMessagePipeline({
        createTree: () => {
          const action = new ActionNode({
            name: 'bomb',
            action: async () => {
              throw new Error('boom');
            },
          });
          return new BehaviorTree({ name: 'fail-tree', root: action });
        },
        stateStore,
        topologyPolicy: 'fail',
        maxQueueDepth: 3,
        context: {},
        createBridge: (sessionKey: string, messageId?: string) =>
          new EventBridge(stateStore, sessionKey, messageId),
        scheduleStreamEviction,
      });

      const msg: ActorMessage = { type: 'tick' };
      const acquired = await stateStore.acquireLock('session-err', 'req-err', 30000);
      expect(acquired).toBe(true);
      const bridge = new EventBridge(stateStore, 'session-err');
      msg.id = bridge.messageId;

      // Action node errors are caught by the tree and result in FAILURE status,
      // not 'error' — the catch path in executeMessage is for unexpected errors
      // outside of actor.process()
      const result = await failPipeline.executeMessage(msg, 'session-err', 'req-err', bridge);

      expect(result.treeStatus).toBe(NodeStatus.FAILURE);
    });
  });

  describe('drainQueue', () => {
    it('processes next queued message', async () => {
      // Enqueue a message
      const queued: ActorMessage = { type: 'tick', id: 'queued-1' };
      await stateStore.enqueueMessage('session-1', queued, 10);

      await pipeline.drainQueue('session-1');

      // Give async executeMessage time to complete
      await new Promise((r) => setTimeout(r, 100));

      // Queue should be empty
      const size = await stateStore.getQueueSize('session-1');
      expect(size).toBe(0);
    });

    it('releases lock when queue is empty', async () => {
      await pipeline.drainQueue('session-1');

      // Lock should be released — a new acquire should succeed
      const acquired = await stateStore.acquireLock('session-1', 'another-req', 30000);
      expect(acquired).toBe(true);
    });

    it('does nothing when lock cannot be acquired', async () => {
      // Hold the lock
      await stateStore.acquireLock('session-1', 'holder', 30000);

      // Enqueue a message
      await stateStore.enqueueMessage('session-1', { type: 'tick' }, 10);

      await pipeline.drainQueue('session-1');

      // Message should still be queued
      const size = await stateStore.getQueueSize('session-1');
      expect(size).toBe(1);
    });
  });

  describe('processMessage', () => {
    it('returns ProcessResult when lock is available', async () => {
      const msg: ActorMessage = { type: 'tick' };
      const result = await pipeline.processMessage(msg, 'session-1');

      expect(result).not.toBeNull();
      if (result && 'treeStatus' in result) {
        expect(result.treeStatus).toBe(NodeStatus.SUCCESS);
      }
    });

    it('returns QueuedResult when lock is held', async () => {
      await stateStore.acquireLock('session-1', 'existing-holder', 30000);

      const msg: ActorMessage = { type: 'tick' };
      const result = await pipeline.processMessage(msg, 'session-1');

      expect(result).not.toBeNull();
      if (result && 'queued' in result) {
        expect(result.queued).toBe(true);
        expect(result.position).toBe(1);
        expect(result.messageId).toBeDefined();
      }
    });

    it('returns null when queue is full', async () => {
      await stateStore.acquireLock('session-1', 'existing-holder', 30000);
      await stateStore.enqueueMessage('session-1', { type: 'tick' }, 3);
      await stateStore.enqueueMessage('session-1', { type: 'tick' }, 3);
      await stateStore.enqueueMessage('session-1', { type: 'tick' }, 3);

      const msg: ActorMessage = { type: 'tick' };
      const result = await pipeline.processMessage(msg, 'session-1');

      expect(result).toBeNull();
    });
  });
});
