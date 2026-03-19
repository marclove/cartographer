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

