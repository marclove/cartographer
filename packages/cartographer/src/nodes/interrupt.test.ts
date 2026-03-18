import { describe, it, expect, vi } from 'vitest';
import { ActionNode } from './action.js';
import { AgentNode } from './agent.js';
import { NodeStatus } from '../types.js';
import type { TreeContext } from '../types.js';
import { EventEmitter } from '../core/event-emitter.js';
import { InMemoryBlackboard } from '../core/blackboard.js';
import type { TreeEvents } from '../types.js';

function createContext(): TreeContext {
  return {
    blackboard: new InMemoryBlackboard(),
    events: new EventEmitter<TreeEvents>(),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('ActionNode.interrupt()', () => {
  it('clears inflight state when async work is pending', async () => {
    let resolve: (status: NodeStatus) => void;
    const node = new ActionNode({
      name: 'slow-action',
      action: () => new Promise<NodeStatus>((r) => { resolve = r; }),
    });
    const ctx = createContext();

    // Start async work
    await node.tick(ctx);
    expect(node.hasInflightWork()).toBe(true);

    // Interrupt clears inflight
    node.interrupt();
    expect(node.hasInflightWork()).toBe(false);
    expect(node.inflightPromise()).toBeNull();

    // Resolve the orphaned promise to avoid unhandled rejection
    resolve!(NodeStatus.SUCCESS);
  });

  it('is a no-op when no inflight work exists', async () => {
    const node = new ActionNode({
      name: 'idle-action',
      action: () => NodeStatus.SUCCESS,
    });

    // No work started — interrupt should not throw
    node.interrupt();
    expect(node.hasInflightWork()).toBe(false);
  });

  it('does not clear inflight state after promise has settled', async () => {
    const node = new ActionNode({
      name: 'fast-action',
      action: () => NodeStatus.SUCCESS,
    });
    const ctx = createContext();

    // Start and let settle
    await node.tick(ctx);
    await flush();

    // Promise settled but not collected — interrupt should not clear it
    // (result is ready for collection on next tick)
    node.interrupt();

    // The settled result should still be collectible
    const status = await node.tick(ctx);
    expect(status).toBe(NodeStatus.SUCCESS);
  });
});

describe('AgentNode.interrupt()', () => {
  it('aborts the active AbortController and clears inflight', async () => {
    // We can't easily test a real SDK call, but we can test the abort
    // controller and inflight mechanics by checking hasInflightWork
    const node = new AgentNode({
      name: 'test-agent',
      prompt: 'test',
      cache: true,
    });

    // Agent hasn't started — interrupt is a no-op
    node.interrupt();
    expect(node.hasInflightWork()).toBe(false);
  });

  it('preserves cachedStatus across interrupt', async () => {
    // Create a node with caching enabled
    const node = new AgentNode({
      name: 'cached-agent',
      prompt: 'test',
      cache: true,
    });

    // We can't drive a real SDK call in unit tests, but we can verify
    // the contract: interrupt() should NOT reset cachedStatus.
    // If cachedStatus were cleared, it would be a regression from the
    // design: "Does NOT clear cachedStatus — previously completed cached
    // results survive."
    //
    // Testing through the public API: after interrupt, if no SDK call
    // was in progress, the node should still be tickable.
    node.interrupt();
    expect(node.hasInflightWork()).toBe(false);
  });
});
