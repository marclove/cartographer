import type { TimelineEvent } from './stores.svelte.js';

/**
 * Format a unix timestamp into a `mm:ss.SSS` display string.
 */
export function formatTimestamp(ts: number): string {
  if (ts == null) return '--:--';
  const d = new Date(ts);
  const min = String(d.getMinutes()).padStart(2, '0');
  const sec = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${min}:${sec}.${ms}`;
}

/**
 * Produce a one-line summary string for an event in the timeline.
 */
export function formatEventSummary(e: TimelineEvent): string {
  const d = e.data as Record<string, unknown>;
  switch (e.event) {
    case 'node:enter':
      return (d['node'] as any)?.name ?? '';
    case 'node:exit': {
      const name = (d['node'] as any)?.name ?? '';
      const status = (d['status'] as string)?.toUpperCase() ?? '';
      const ms = d['durationMs'] != null ? `${d['durationMs']}ms` : '';
      return `${name} — ${status} ${ms}`;
    }
    case 'node:error':
      return `${(d['node'] as any)?.name ?? ''}: ${d['error'] ?? 'unknown error'}`;
    case 'agent:thinking':
      return `${d['text'] ?? ''}`;
    case 'agent:text':
      return `${d['text'] ?? ''}`;
    case 'agent:tool_use':
      return `${d['tool'] ?? ''}`;
    case 'agent:response':
      return d['cost'] != null ? `cost: $${Number(d['cost']).toFixed(4)}` : 'completed';
    case 'agent:init': {
      const tools = (d['tools'] as unknown[])?.length ?? 0;
      const mcps = (d['mcpServers'] as unknown[])?.length ?? 0;
      return `model: ${d['model'] ?? ''}, ${tools} tools, ${mcps} MCP servers`;
    }
    case 'agent:status':
      return `${d['status'] ?? ''}`;
    case 'agent:prompt':
      return `${d['prompt'] ?? ''}`;
    case 'agent:tool_progress': {
      const elapsed = d['elapsedSeconds'] != null ? `${d['elapsedSeconds']}s` : '';
      return `${d['toolName'] ?? ''} ${elapsed}`;
    }
    case 'agent:rate_limit':
      return JSON.stringify(d['info'] ?? '');
    case 'agent:error':
      return `${d['subtype'] ?? ''}: ${(d['errors'] as string[])?.join(', ') ?? ''}`;
    case 'blackboard:read':
      return d['hit'] ? `${d['key']} = ${JSON.stringify(d['value'])}` : `${d['key']} (miss)`;
    case 'blackboard:write':
      return `${d['key']} = ${JSON.stringify(d['value'])}`;
    case 'tree:tick': {
      const s = (d['status'] as string)?.toUpperCase() ?? '';
      return `${d['tree'] ?? ''} — ${s} (${d['durationMs']}ms)`;
    }
    case 'tree:tick:skipped':
      return 'tick skipped (overlap)';
    case 'tree:reset':
    case 'tree:abort':
      return `${d['tree'] ?? ''}`;
    case 'strategy:decision':
      return `${d['strategy'] ?? ''}`;
    default:
      return JSON.stringify(d);
  }
}

/**
 * Full JSON detail view for an expanded event.
 */
export function formatEventDetail(e: TimelineEvent): string {
  return JSON.stringify(e.data, null, 2);
}
