import type {
  ApiTree,
  RunStatus,
  ApiBlackboard,
  NodeRef,
  SseEventMap,
  SseEventName,
} from './types.js';

// ---------------------------------------------------------------------------
// Base URL — resolves to the dashboard server's origin in production,
// and can be overridden for tests.
// ---------------------------------------------------------------------------

function baseUrl(): string {
  return typeof window !== 'undefined' ? window.location.origin : '';
}

// ---------------------------------------------------------------------------
// REST helpers
// ---------------------------------------------------------------------------

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`);
  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText);
    throw new Error(`GET ${path} failed (${res.status}): ${body}`);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// REST API
// ---------------------------------------------------------------------------

/** Fetch the full serialized tree structure. */
export function fetchTree(): Promise<ApiTree> {
  return get<ApiTree>('/api/tree');
}

/** Fetch current run status (tick count, last status, uptime, etc.). */
export function fetchStatus(): Promise<RunStatus> {
  return get<RunStatus>('/api/status');
}

/** Fetch the current blackboard contents. */
export function fetchBlackboard(): Promise<ApiBlackboard> {
  return get<ApiBlackboard>('/api/blackboard');
}

/** Fetch a single node by id. */
export function fetchNode(nodeId: string): Promise<NodeRef> {
  return get<NodeRef>(`/api/nodes/${encodeURIComponent(nodeId)}`);
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

export type SseEventHandler<K extends SseEventName> = (
  data: SseEventMap[K],
  id: number,
) => void;

export interface SseHandlers extends Partial<{
  [K in SseEventName]: SseEventHandler<K>;
}> {
  /** Called when the connection is established (after the first message). */
  onOpen?: () => void;
  /** Called when the connection is closed or encounters an error. */
  onError?: (err: Event) => void;
}

/**
 * Open an SSE connection to the dashboard server.
 *
 * Returns a cleanup function that closes the connection when called.
 */
export function connectSSE(handlers: SseHandlers): () => void {
  const url = `${baseUrl()}/events`;
  const es = new EventSource(url);

  if (handlers.onError) {
    es.addEventListener('error', handlers.onError);
  }

  // Register named event listeners
  const eventNames: SseEventName[] = [
    'snapshot',
    'node:enter',
    'node:exit',
    'node:error',
    'agent:prompt',
    'agent:thinking',
    'agent:text',
    'agent:tool_use',
    'agent:response',
    'agent:error',
    'agent:message',
    'agent:tool_progress',
    'agent:init',
    'agent:status',
    'agent:rate_limit',
    'agent:elicitation_declined',
    'tree:init',
    'tree:tick',
    'tree:tick:skipped',
    'tree:reset',
    'tree:abort',
    'blackboard:read',
    'blackboard:write',
    'strategy:decision',
  ];

  let openFired = false;

  for (const name of eventNames) {
    const handler = handlers[name] as SseEventHandler<typeof name> | undefined;
    if (!handler) continue;

    es.addEventListener(name, (e: MessageEvent) => {
      if (!openFired && handlers.onOpen) {
        handlers.onOpen();
        openFired = true;
      }
      const id = parseInt((e as MessageEvent & { lastEventId: string }).lastEventId, 10);
      const data = JSON.parse(e.data) as SseEventMap[typeof name];
      handler(data, id);
    });
  }

  return () => es.close();
}
