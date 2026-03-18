import { describe, it, expect, vi } from 'vitest';
import type { ServerResponse } from 'node:http';
import { NodeStatus } from '../types.js';
import { ActionNode } from '../nodes/action.js';
import { SequenceNode } from '../composites/sequence.js';
import { InMemoryBlackboard } from '../core/blackboard.js';
import { BehaviorTree } from '../core/behavior-tree.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
  createSdkMcpServer: vi.fn(() => ({})),
  tool: vi.fn((_name: string, _desc: string, _schema: unknown, handler: unknown) => handler),
}));

import { AgentNode } from '../nodes/agent.js';
import {
  handleApiTree,
  handleApiStatus,
  handleApiBlackboard,
  handleApiNode,
  findNodeById,
  type StatusState,
} from './api-handlers.js';

function createMockRes(): ServerResponse & { _status: number; _body: unknown } {
  const res = {
    _status: 0,
    _body: undefined as unknown,
    writeHead(status: number, _headers: Record<string, string>) {
      res._status = status;
    },
    end(data: string) {
      res._body = JSON.parse(data);
    },
  } as unknown as ServerResponse & { _status: number; _body: unknown };
  return res;
}

function makeAction(name: string): ActionNode {
  return new ActionNode({ name, action: async () => NodeStatus.SUCCESS });
}

function makeTree(root: ActionNode | SequenceNode | AgentNode, bbEntries?: Record<string, unknown>): BehaviorTree {
  const bb = new InMemoryBlackboard();
  if (bbEntries) {
    for (const [k, v] of Object.entries(bbEntries)) {
      bb.set(k, v);
    }
  }
  return new BehaviorTree({ name: 'test-tree', root, blackboard: bb });
}

// ---- handleApiTree ----

describe('handleApiTree', () => {
  it('returns 200 with tree name and serialized root', () => {
    const action = makeAction('leaf');
    const tree = makeTree(action);
    const res = createMockRes();

    handleApiTree(res, tree);

    expect(res._status).toBe(200);
    const body = res._body as Record<string, unknown>;
    expect(body.tree).toBe('test-tree');
    expect(body.root).toEqual({
      id: action.id,
      name: 'leaf',
      type: 'action',
      children: [],
    });
  });
});

// ---- handleApiStatus ----

describe('handleApiStatus', () => {
  it('returns 200 with tick/cycle counts, lastStatus, lastDurationMs, and uptime', () => {
    const tree = makeTree(makeAction('a'));
    const res = createMockRes();
    const state: StatusState = {
      tickCount: 5,
      cycleCount: 2,
      lastStatus: 'SUCCESS',
      lastDurationMs: 42,
      startedAt: Date.now() - 1000,
    };

    handleApiStatus(res, tree, state);

    expect(res._status).toBe(200);
    const body = res._body as Record<string, unknown>;
    expect(body.tree).toBe('test-tree');
    expect(body.tickCount).toBe(5);
    expect(body.cycleCount).toBe(2);
    expect(body.lastStatus).toBe('SUCCESS');
    expect(body.lastDurationMs).toBe(42);
    expect(typeof body.uptime).toBe('number');
    expect(body.uptime).toBeGreaterThanOrEqual(900);
  });
});

// ---- handleApiBlackboard ----

describe('handleApiBlackboard', () => {
  it('returns 200 with blackboard record', () => {
    const tree = makeTree(makeAction('a'), { foo: 'bar', count: 7 });
    const res = createMockRes();

    handleApiBlackboard(res, tree);

    expect(res._status).toBe(200);
    const body = res._body as Record<string, unknown>;
    expect(body.foo).toBe('bar');
    expect(body.count).toBe(7);
  });
});

// ---- handleApiNode ----

describe('handleApiNode', () => {
  it('returns 404 for unknown node ID', () => {
    const tree = makeTree(makeAction('a'));
    const res = createMockRes();

    handleApiNode(res, tree, 'nonexistent-id');

    expect(res._status).toBe(404);
    expect((res._body as Record<string, unknown>).error).toBe('Not found');
  });

  it('returns AgentNode details including model, tools, and mcpServers', () => {
    const agent = new AgentNode({
      name: 'my-agent',
      prompt: 'hello',
      options: {
        model: 'claude-sonnet-4-20250514',
        allowedTools: ['tool_a', 'tool_b'],
        mcpServers: { server1: {} as any, server2: {} as any },
      },
    });
    const tree = makeTree(agent);
    const res = createMockRes();

    handleApiNode(res, tree, agent.id);

    expect(res._status).toBe(200);
    const body = res._body as Record<string, unknown>;
    expect(body.id).toBe(agent.id);
    expect(body.name).toBe('my-agent');
    expect(body.type).toBe('agent');
    expect(body.model).toBe('claude-sonnet-4-20250514');
    expect(body.tools).toEqual(['tool_a', 'tool_b']);
    expect(body.mcpServers).toEqual(['server1', 'server2']);
  });

  it('returns children for composite nodes', () => {
    const child1 = makeAction('c1');
    const child2 = makeAction('c2');
    const seq = new SequenceNode({ name: 'seq', children: [child1, child2] });
    const tree = makeTree(seq);
    const res = createMockRes();

    handleApiNode(res, tree, seq.id);

    expect(res._status).toBe(200);
    const body = res._body as Record<string, unknown>;
    expect(body.type).toBe('sequence');
    expect(body.children).toEqual([
      { id: child1.id, name: 'c1', type: 'action' },
      { id: child2.id, name: 'c2', type: 'action' },
    ]);
  });

  it('handles AgentNode with missing optional fields', () => {
    const agent = new AgentNode({
      name: 'minimal-agent',
      prompt: 'hi',
    });
    const tree = makeTree(agent);
    const res = createMockRes();

    handleApiNode(res, tree, agent.id);

    expect(res._status).toBe(200);
    const body = res._body as Record<string, unknown>;
    expect(body.model).toBeUndefined();
    expect(body.tools).toEqual([]);
    expect(body.mcpServers).toEqual([]);
  });
});

// ---- findNodeById ----

describe('findNodeById', () => {
  it('finds root node by ID', () => {
    const root = makeAction('root');
    const found = findNodeById(root, root.id);
    expect(found).toBe(root);
  });

  it('finds a deeply nested node (3+ levels)', () => {
    const deep = makeAction('deep-leaf');
    const mid = new SequenceNode({ name: 'mid', children: [deep] });
    const top = new SequenceNode({ name: 'top', children: [mid] });

    const found = findNodeById(top, deep.id);
    expect(found).toBe(deep);
  });

  it('returns undefined for non-existent ID', () => {
    const root = makeAction('root');
    expect(findNodeById(root, 'does-not-exist')).toBeUndefined();
  });

  it('works with composite nodes containing multiple children at each level', () => {
    const a = makeAction('a');
    const b = makeAction('b');
    const c = makeAction('c');
    const d = makeAction('d');
    const inner = new SequenceNode({ name: 'inner', children: [c, d] });
    const outer = new SequenceNode({ name: 'outer', children: [a, b, inner] });

    expect(findNodeById(outer, a.id)).toBe(a);
    expect(findNodeById(outer, d.id)).toBe(d);
    expect(findNodeById(outer, inner.id)).toBe(inner);
  });
});
