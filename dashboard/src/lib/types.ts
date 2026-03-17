// ---------------------------------------------------------------------------
// Shared client-side types for the Cartographer dashboard
// ---------------------------------------------------------------------------

// ---- Tree structure -------------------------------------------------------

export interface TreeNode {
  id: string;
  name: string;
  type: 'action' | 'condition' | 'agent' | 'sequence' | 'selector' | 'parallel' | 'decorator' | 'unknown';
  children: TreeNode[];
}

// ---- REST API response shapes ---------------------------------------------

/** Response from GET /api/tree */
export interface ApiTree {
  tree: string;
  root: TreeNode;
}

/** Response from GET /api/status */
export interface RunStatus {
  tree: string;
  tickCount: number;
  cycleCount: number;
  lastStatus: string | null;
  lastDurationMs: number | null;
  uptime: number;
}

/** Response from GET /api/blackboard */
export type ApiBlackboard = Record<string, unknown>;

/** Response from GET /api/nodes/:id */
export interface NodeRef {
  id: string;
  name: string;
  type: string;
}

// ---- SSE event payloads ---------------------------------------------------

export interface Snapshot {
  tree: TreeNode;
  blackboard: Record<string, unknown>;
  stats?: {
    tickCount: number;
    cycleCount: number;
    lastStatus: string | null;
    lastDurationMs: number | null;
    asOfEventId: number;
  };
}

export interface NodeEnterEvent {
  node: NodeRef;
}

export interface NodeExitEvent {
  node: NodeRef;
  status: 'success' | 'failure' | 'running';
  durationMs: number;
}

export interface NodeErrorEvent {
  node: NodeRef;
  error: string;
}

export interface AgentPromptEvent {
  nodeId: string;
  prompt: string;
}

export interface AgentThinkingEvent {
  nodeId: string;
  text: string;
}

export interface AgentTextEvent {
  nodeId: string;
  text: string;
}

export interface AgentToolUseEvent {
  nodeId: string;
  tool: string;
  input: unknown;
}

export interface AgentResponseEvent {
  nodeId: string;
  result: unknown;
  cost: unknown;
  modelUsage: unknown;
}

export interface AgentErrorEvent {
  nodeId: string;
  subtype: string;
  errors: unknown;
  permissionDenials: unknown;
  cost: unknown;
  modelUsage: unknown;
}

export interface AgentMessageEvent {
  nodeId: string;
  message: unknown;
}

export interface AgentToolProgressEvent {
  nodeId: string;
  toolUseId: string;
  toolName: string;
  elapsedSeconds: number;
}

export interface AgentInitEvent {
  nodeId: string;
  sessionId: string;
  model: string;
  tools: unknown;
  mcpServers: unknown;
}

export interface AgentStatusEvent {
  nodeId: string;
  status: string;
}

export interface AgentRateLimitEvent {
  nodeId: string;
  info: unknown;
}

export interface AgentElicitationDeclinedEvent {
  nodeId: string;
  request: unknown;
}

export interface TreeInitEvent {
  tree: string;
  [key: string]: unknown;
}

export interface TreeTickEvent {
  tree: string;
  status: string;
  durationMs: number;
  [key: string]: unknown;
}

export interface TreeResetEvent {
  tree: string;
  [key: string]: unknown;
}

export interface TreeAbortEvent {
  tree: string;
  [key: string]: unknown;
}

export interface TreeTickSkippedEvent {
  timestamp: number;
}

export interface BlackboardKeysEvent {
  keys: string[];
  [key: string]: unknown;
}

export interface BlackboardReadEvent {
  key: string;
  value: unknown;
  hit: boolean;
  [key: string]: unknown;
}

export interface BlackboardWriteEvent {
  key: string;
  value: unknown;
  [key: string]: unknown;
}

export interface StrategyDecisionEvent {
  compositeId: string;
  strategy: string;
  decision: unknown;
}

// ---- Actor lifecycle events ------------------------------------------------

export interface MessageProcessedEvent {
  messageId: string;
  treeStatus: string;
}

export interface MessageInterruptedEvent {
  messageId: string;
}

export interface MessageFailedEvent {
  messageId: string;
  error: string;
}

// ---- SSE message envelope -------------------------------------------------

export type SseEventMap = {
  snapshot: Snapshot;
  'node:enter': NodeEnterEvent;
  'node:exit': NodeExitEvent;
  'node:error': NodeErrorEvent;
  'agent:prompt': AgentPromptEvent;
  'agent:thinking': AgentThinkingEvent;
  'agent:text': AgentTextEvent;
  'agent:tool_use': AgentToolUseEvent;
  'agent:response': AgentResponseEvent;
  'agent:error': AgentErrorEvent;
  'agent:message': AgentMessageEvent;
  'agent:tool_progress': AgentToolProgressEvent;
  'agent:init': AgentInitEvent;
  'agent:status': AgentStatusEvent;
  'agent:rate_limit': AgentRateLimitEvent;
  'agent:elicitation_declined': AgentElicitationDeclinedEvent;
  'tree:init': TreeInitEvent;
  'tree:tick': TreeTickEvent;
  'tree:reset': TreeResetEvent;
  'tree:abort': TreeAbortEvent;
  'tree:tick:skipped': TreeTickSkippedEvent;
  'blackboard:keys': BlackboardKeysEvent;
  'blackboard:read': BlackboardReadEvent;
  'blackboard:write': BlackboardWriteEvent;
  'strategy:decision': StrategyDecisionEvent;
  'message:processed': MessageProcessedEvent;
  'message:interrupted': MessageInterruptedEvent;
  'message:failed': MessageFailedEvent;
};

export type SseEventName = keyof SseEventMap;

export interface SseMessage<K extends SseEventName = SseEventName> {
  id: number;
  event: K;
  data: SseEventMap[K];
}
