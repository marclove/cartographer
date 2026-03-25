import { describe, it, expect } from 'vitest';
import { SequenceNode } from './sequence.js';
import { SelectorNode } from './selector.js';
import { ParallelNode } from './parallel.js';
import { AlwaysSucceed } from '../decorators/always-succeed.js';
import { Inverter } from '../decorators/inverter.js';
import { ActionNode } from '../nodes/action.js';
import { NodeStatus } from '../types.js';
import type { TreeContext } from '../types.js';
import { EventEmitter } from '../core/event-emitter.js';
import { InMemoryBlackboard } from '../core/blackboard.js';
import { SessionRegistry } from '../core/session-registry.js';
import type { TreeEvents } from '../types.js';

function createContext(): TreeContext {
  return {
    blackboard: new InMemoryBlackboard(),
    events: new EventEmitter<TreeEvents>(),
    sessions: new SessionRegistry(),
  };
}

const flush = () => new Promise(r => setTimeout(r, 0));

describe('composite inflight delegation', () => {
  it('sequence reports inflight work from a child', async () => {
    let resolve: (s: NodeStatus) => void;
    const slow = new ActionNode({
      name: 'slow',
      action: () => new Promise<NodeStatus>(r => { resolve = r; }),
    });
    const seq = new SequenceNode({ name: 'seq', children: [slow] });
    const ctx = createContext();

    await seq.tick(ctx);
    expect(seq.hasInflightWork()).toBe(true);
    expect(seq.inflightPromise()).toBeInstanceOf(Promise);

    resolve!(NodeStatus.SUCCESS);
    await flush();
    expect(seq.hasInflightWork()).toBe(false);
    expect(seq.inflightPromise()).toBeNull();
  });

  it('selector reports inflight work from a child', async () => {
    let resolve: (s: NodeStatus) => void;
    const slow = new ActionNode({
      name: 'slow',
      action: () => new Promise<NodeStatus>(r => { resolve = r; }),
    });
    const sel = new SelectorNode({ name: 'sel', children: [slow] });
    const ctx = createContext();

    await sel.tick(ctx);
    expect(sel.hasInflightWork()).toBe(true);

    resolve!(NodeStatus.SUCCESS);
    await flush();
    expect(sel.hasInflightWork()).toBe(false);
  });

  it('parallel reports inflight work from any child', async () => {
    let resolve1: (s: NodeStatus) => void;
    let resolve2: (s: NodeStatus) => void;
    const slow1 = new ActionNode({
      name: 'slow1',
      action: () => new Promise<NodeStatus>(r => { resolve1 = r; }),
    });
    const slow2 = new ActionNode({
      name: 'slow2',
      action: () => new Promise<NodeStatus>(r => { resolve2 = r; }),
    });
    const par = new ParallelNode({ name: 'par', children: [slow1, slow2] });
    const ctx = createContext();

    await par.tick(ctx);
    expect(par.hasInflightWork()).toBe(true);

    resolve1!(NodeStatus.SUCCESS);
    await flush();
    // Still true because slow2 is still in-flight
    expect(par.hasInflightWork()).toBe(true);

    resolve2!(NodeStatus.SUCCESS);
    await flush();
    expect(par.hasInflightWork()).toBe(false);
  });
});

describe('decorator inflight delegation', () => {
  it('AlwaysSucceed reports inflight work from its child', async () => {
    let resolve: (s: NodeStatus) => void;
    const slow = new ActionNode({
      name: 'slow',
      action: () => new Promise<NodeStatus>(r => { resolve = r; }),
    });
    const decorated = new AlwaysSucceed({ name: 'wrap', child: slow });
    const ctx = createContext();

    await decorated.tick(ctx);
    expect(decorated.hasInflightWork()).toBe(true);
    expect(decorated.inflightPromise()).toBeInstanceOf(Promise);

    resolve!(NodeStatus.SUCCESS);
    await flush();
    expect(decorated.hasInflightWork()).toBe(false);
    expect(decorated.inflightPromise()).toBeNull();
  });

  it('Inverter reports inflight work from its child', async () => {
    let resolve: (s: NodeStatus) => void;
    const slow = new ActionNode({
      name: 'slow',
      action: () => new Promise<NodeStatus>(r => { resolve = r; }),
    });
    const decorated = new Inverter({ name: 'inv', child: slow });
    const ctx = createContext();

    await decorated.tick(ctx);
    expect(decorated.hasInflightWork()).toBe(true);

    resolve!(NodeStatus.SUCCESS);
    await flush();
    expect(decorated.hasInflightWork()).toBe(false);
  });

  it('nested composite + decorator delegates through the full chain', async () => {
    let resolve: (s: NodeStatus) => void;
    const slow = new ActionNode({
      name: 'slow',
      action: () => new Promise<NodeStatus>(r => { resolve = r; }),
    });
    const inner = new SequenceNode({ name: 'inner', children: [slow] });
    const outer = new AlwaysSucceed({ name: 'outer', child: inner });
    const ctx = createContext();

    await outer.tick(ctx);
    expect(outer.hasInflightWork()).toBe(true);

    resolve!(NodeStatus.SUCCESS);
    await flush();
    expect(outer.hasInflightWork()).toBe(false);
  });
});
