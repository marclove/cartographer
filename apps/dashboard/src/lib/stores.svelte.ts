import { getContext } from 'svelte';
import type { CartographerClient } from '@cartographer/client';
import type { TreeNode } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NodeStatus = 'running' | 'success' | 'failure' | null;

export interface TimelineEvent {
  id: number;
  event: string;
  timestamp: number;
  data: unknown;
  category: string;
}

// ---------------------------------------------------------------------------
// Event categorization
// ---------------------------------------------------------------------------

export const EVENT_CATEGORIES: Record<string, string> = {
  'node:enter': 'nodes',
  'node:exit': 'nodes',
  'node:error': 'nodes',
  'tree:init': 'nodes',
  'tree:tick': 'nodes',
  'tree:reset': 'nodes',
  'tree:abort': 'nodes',
  'tree:tick:skipped': 'nodes',
  'agent:prompt': 'agent',
  'agent:thinking': 'agent',
  'agent:text': 'agent',
  'agent:tool_use': 'agent',
  'agent:response': 'agent',
  'agent:error': 'agent',
  'agent:message': 'agent',
  'agent:tool_progress': 'agent',
  'agent:init': 'agent',
  'agent:status': 'agent',
  'agent:rate_limit': 'agent',
  'agent:elicitation_declined': 'agent',
  'blackboard:keys': 'blackboard',
  'blackboard:read': 'blackboard',
  'blackboard:write': 'blackboard',
  'strategy:decision': 'strategy',
  'message:processed': 'lifecycle',
  'message:interrupted': 'lifecycle',
  'message:failed': 'lifecycle',
};

export function getEventCategory(eventName: string): string {
  return EVENT_CATEGORIES[eventName] ?? 'other';
}

// ---------------------------------------------------------------------------
// DashboardState
// ---------------------------------------------------------------------------

const MAX_EVENTS = 2000;

/** All SSE event types the dashboard subscribes to. */
const ALL_EVENTS = [
  'snapshot',
  'node:enter', 'node:exit', 'node:error',
  'tree:tick', 'tree:tick:skipped', 'tree:reset', 'tree:init', 'tree:abort',
  'blackboard:keys', 'blackboard:read', 'blackboard:write',
  'strategy:decision',
  'message:processed', 'message:interrupted', 'message:failed',
  'agent:prompt', 'agent:thinking', 'agent:text', 'agent:tool_use',
  'agent:response', 'agent:error', 'agent:message', 'agent:tool_progress',
  'agent:init', 'agent:status', 'agent:rate_limit', 'agent:elicitation_declined',
];

export class DashboardState {
  // Tree structure
  treeName = $state<string>('');
  treeRoot = $state<TreeNode | null>(null);

  // Node status tracking
  nodeStatuses = $state<Map<string, NodeStatus>>(new Map());

  // Run stats
  tickCount = $state(0);
  cycleCount = $state(0);
  lastStatus = $state<string | null>(null);
  lastDurationMs = $state<number | null>(null);

  // Event timeline
  events = $state<TimelineEvent[]>([]);

  // Event filters
  activeFilters = $state<Set<string>>(
    new Set(['nodes', 'agent', 'blackboard', 'strategy', 'lifecycle']),
  );

  // Blackboard
  blackboard = $state<Record<string, unknown>>({});
  recentlyUpdatedKeys = $state<Set<string>>(new Set());

  // Selected node
  selectedNodeId = $state<string | null>(null);
  nodeDetail = $state<Record<string, unknown> | null>(null);

  // Private state
  private statsBaselineCounter = 0;
  private highlightTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private baseUrl = '';

  // ---------------------------------------------------------------------------
  // Event handling
  // ---------------------------------------------------------------------------

  private pushEvent(event: string, data: unknown, id: number): void {
    const entry: TimelineEvent = {
      id,
      event,
      timestamp: Date.now(),
      data,
      category: getEventCategory(event),
    };
    this.events.push(entry);
    if (this.events.length > MAX_EVENTS) {
      this.events = this.events.slice(-MAX_EVENTS);
    } else {
      this.events = this.events;
    }
  }

  private handleEvent(event: string, raw: unknown): void {
    const data = raw as Record<string, unknown>;
    // Use a monotonically increasing local ID since the client doesn't
    // forward the SSE lastEventId.
    const id = ++this._eventCounter;

    switch (event) {
      case 'snapshot': {
        const tree = data['tree'] as TreeNode;
        this.treeName = tree.name;
        this.treeRoot = tree;
        this.blackboard = data['blackboard'] as Record<string, unknown>;
        const stats = data['stats'] as {
          tickCount: number; cycleCount: number;
          lastStatus: string | null; lastDurationMs: number | null;
          asOfEventId: number;
        } | undefined;
        if (stats) {
          this.tickCount = stats.tickCount;
          this.cycleCount = stats.cycleCount;
          this.lastStatus = stats.lastStatus;
          this.lastDurationMs = stats.lastDurationMs;
          // Record the current local counter as the baseline. Events replayed
          // after this snapshot carry server IDs that were already counted in
          // the snapshot stats — we use the local counter (not the server ID)
          // since the client.on() API doesn't forward lastEventId.
          this.statsBaselineCounter = this._eventCounter;
        } else {
          this.statsBaselineCounter = 0;
        }
        this.nodeStatuses = new Map();
        break;
      }
      case 'node:enter': {
        const node = data['node'] as { id: string };
        const next = (this.treeRoot && node.id === this.treeRoot.id)
          ? new Map<string, NodeStatus>()
          : new Map(this.nodeStatuses);
        next.set(node.id, 'running');
        this.nodeStatuses = next;
        break;
      }
      case 'node:exit': {
        const node = data['node'] as { id: string };
        const next = new Map(this.nodeStatuses);
        next.set(node.id, data['status'] as NodeStatus);
        this.nodeStatuses = next;
        break;
      }
      case 'node:error': {
        const node = data['node'] as { id: string };
        const next = new Map(this.nodeStatuses);
        next.set(node.id, 'failure');
        this.nodeStatuses = next;
        break;
      }
      case 'tree:tick': {
        if (id > this.statsBaselineCounter) {
          this.tickCount += 1;
          if (data['status'] !== 'running') {
            this.cycleCount += 1;
          }
        }
        this.lastStatus = data['status'] as string;
        this.lastDurationMs = data['durationMs'] as number;
        break;
      }
      case 'tree:reset':
        this.nodeStatuses = new Map();
        break;
      case 'blackboard:write': {
        const key = typeof data['key'] === 'string' ? data['key'] : null;
        if (key !== null) {
          this.blackboard = { ...this.blackboard, [key]: data['value'] };
          const next = new Set(this.recentlyUpdatedKeys);
          next.add(key);
          this.recentlyUpdatedKeys = next;
          const existing = this.highlightTimers.get(key);
          if (existing !== undefined) clearTimeout(existing);
          this.highlightTimers.set(key, setTimeout(() => {
            const cleared = new Set(this.recentlyUpdatedKeys);
            cleared.delete(key);
            this.recentlyUpdatedKeys = cleared;
            this.highlightTimers.delete(key);
          }, 2000));
        }
        break;
      }
      // All other events: no special state handling, just push to timeline
    }

    this.pushEvent(event, data, id);
  }

  private _eventCounter = 0;

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Subscribe to all SSE events via `client.on()`.
   * @param client - The CartographerClient to subscribe to.
   * @param baseUrl - Base URL of the Cartographer server, used for node detail fetches.
   * @returns A cleanup function that removes all listeners.
   */
  wire(client: CartographerClient, baseUrl = ''): () => void {
    this.baseUrl = baseUrl;

    const handlers = new Map<string, (data: unknown) => void>();
    for (const event of ALL_EVENTS) {
      const handler = (data: unknown) => this.handleEvent(event, data);
      handlers.set(event, handler);
      client.on(event, handler);
    }

    return () => {
      for (const [event, handler] of handlers) {
        client.off(event, handler);
      }
      for (const timer of this.highlightTimers.values()) clearTimeout(timer);
      this.highlightTimers.clear();
    };
  }

  selectNode(id: string | null): void {
    if (id === null) {
      this.selectedNodeId = null;
      this.nodeDetail = null;
      return;
    }
    this.selectedNodeId = this.selectedNodeId === id ? null : id;
    if (this.selectedNodeId) {
      const nodeId = this.selectedNodeId;
      fetch(`${this.baseUrl}/api/nodes/${encodeURIComponent(nodeId)}`)
        .then((res) => res.json())
        .then((data) => {
          this.nodeDetail = data as Record<string, unknown>;
        })
        .catch(() => {
          this.nodeDetail = null;
        });
    } else {
      this.nodeDetail = null;
    }
  }

  toggleFilter(filter: string): void {
    const next = new Set(this.activeFilters);
    if (next.has(filter)) {
      next.delete(filter);
    } else {
      next.add(filter);
    }
    this.activeFilters = next;
  }
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export const DASHBOARD_STATE_KEY = Symbol('dashboard-state');

export function getDashboardState(): DashboardState {
  const state = getContext<DashboardState>(DASHBOARD_STATE_KEY);
  if (!state) {
    throw new Error('getDashboardState() must be called inside a DashboardProvider');
  }
  return state;
}
