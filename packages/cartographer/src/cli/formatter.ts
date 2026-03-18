import type { TypedEventEmitter, TreeEvents, BTreeNode, ModelUsage } from '../types.js';

export interface FormatterOptions {
  /** Emit events as JSON lines (NDJSON) instead of formatted text. */
  json?: boolean;
  /** Include agent:thinking and agent:tool_use events. */
  verbose?: boolean;
  /** Suppress all output except errors and the final status line. */
  quiet?: boolean;
}

/**
 * Subscribe to tree events and render structured output to stdout.
 *
 * Returns a cleanup function that removes all listeners.
 */
export function createFormatter(
  events: TypedEventEmitter<TreeEvents>,
  options: FormatterOptions = {},
): () => void {
  if (options.quiet && !options.json) {
    return createQuietFormatter(events);
  }
  if (options.json) {
    return createJsonFormatter(events, options);
  }
  return createTextFormatter(events, options);
}

// --- JSON formatter ---

function createJsonFormatter(
  events: TypedEventEmitter<TreeEvents>,
  options: FormatterOptions,
): () => void {
  const cleanup: Array<() => void> = [];

  function on<K extends keyof TreeEvents & string>(
    event: K,
    handler: (data: TreeEvents[K]) => void,
  ): void {
    events.on(event, handler);
    cleanup.push(() => events.off(event, handler));
  }

  function write(entry: Record<string, unknown>): void {
    process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  }

  on('node:enter', ({ node }) => {
    write({ event: 'node:enter', node: node.name, nodeId: node.id });
  });

  on('node:exit', ({ node, status, durationMs }) => {
    write({ event: 'node:exit', node: node.name, nodeId: node.id, status, durationMs: round(durationMs) });
  });

  on('node:error', ({ node, error }) => {
    write({ event: 'node:error', node: node.name, nodeId: node.id, error: error.message });
  });

  on('agent:prompt', ({ node, prompt }) => {
    write({ event: 'agent:prompt', node: node.name, prompt });
  });

  if (options.verbose) {
    on('agent:thinking', ({ node, thinking }) => {
      write({ event: 'agent:thinking', node: node.name, thinking });
    });
  }

  on('agent:text', ({ node, text }) => {
    write({ event: 'agent:text', node: node.name, text });
  });

  on('agent:tool_use', ({ node, tool, input }) => {
    write({ event: 'agent:tool_use', node: node.name, tool, input });
  });

  on('agent:response', ({ node, result, cost, modelUsage }) => {
    write({ event: 'agent:response', node: node.name, result, cost, modelUsage });
  });

  on('agent:error', ({ node, subtype, errors: errs, cost, modelUsage }) => {
    write({ event: 'agent:error', node: node.name, subtype, errors: errs, cost, modelUsage });
  });

  on('tree:tick', ({ tree, status, durationMs }) => {
    write({ event: 'tree:tick', tree, status, durationMs: round(durationMs) });
  });

  on('tree:reset', ({ tree }) => {
    write({ event: 'tree:reset', tree });
  });

  on('tree:abort', ({ tree }) => {
    write({ event: 'tree:abort', tree });
  });

  on('strategy:decision', ({ composite, strategy, decision }) => {
    write({ event: 'strategy:decision', composite: composite.name, strategy, decision });
  });

  return () => { for (const off of cleanup) off(); };
}

// --- Quiet formatter ---

function createQuietFormatter(
  events: TypedEventEmitter<TreeEvents>,
): () => void {
  const cleanup: Array<() => void> = [];

  function on<K extends keyof TreeEvents & string>(
    event: K,
    handler: (data: TreeEvents[K]) => void,
  ): void {
    events.on(event, handler);
    cleanup.push(() => events.off(event, handler));
  }

  on('node:error', ({ node, error }) => {
    process.stderr.write(`ERROR [${node.name}]: ${error.message}\n`);
  });

  on('tree:tick', ({ tree, status, durationMs }) => {
    process.stdout.write(`${tree} — ${status.toUpperCase()} (${round(durationMs)}ms)\n`);
  });

  return () => { for (const off of cleanup) off(); };
}

// --- Text formatter ---

function createTextFormatter(
  events: TypedEventEmitter<TreeEvents>,
  options: FormatterOptions,
): () => void {
  const cleanup: Array<() => void> = [];
  const activeNodes: BTreeNode[] = [];
  const nodeDepths = new Map<BTreeNode, number>();
  const modelUsage = new Map<string, ModelUsage>();

  function on<K extends keyof TreeEvents & string>(
    event: K,
    handler: (data: TreeEvents[K]) => void,
  ): void {
    events.on(event, handler);
    cleanup.push(() => events.off(event, handler));
  }

  function computeDepth(node: BTreeNode): number {
    // Walk active nodes (most recent first) to find a parent whose .children includes this node
    for (let i = activeNodes.length - 1; i >= 0; i--) {
      const candidate = activeNodes[i] as any;
      if (candidate.children && Array.isArray(candidate.children) && candidate.children.includes(node)) {
        return (nodeDepths.get(activeNodes[i]) ?? 0) + 1;
      }
    }
    // Fallback: use stack length (equivalent to old counter behavior)
    return activeNodes.length;
  }

  function pad(d: number): string {
    return '  '.repeat(d);
  }

  function print(line: string): void {
    process.stdout.write(line + '\n');
  }

  function nodeType(node: BTreeNode): string {
    // Derive a short type label from the constructor name
    const name = node.constructor?.name ?? 'node';
    // Strip trailing "Node" suffix: "ActionNode" → "action", "SequenceNode" → "sequence"
    const short = name.replace(/Node$/, '').toLowerCase();
    return short || 'node';
  }

  function currentDepth(node: BTreeNode): number {
    return nodeDepths.get(node) ?? 0;
  }

  on('node:enter', ({ node }) => {
    const d = computeDepth(node);
    nodeDepths.set(node, d);
    print(`${pad(d)}▶ [${nodeType(node)}] ${node.name}`);
    activeNodes.push(node);
  });

  on('node:exit', ({ node, status, durationMs }) => {
    const d = currentDepth(node);
    const idx = activeNodes.indexOf(node);
    if (idx !== -1) activeNodes.splice(idx, 1);
    nodeDepths.delete(node);
    const symbol = status === 'success' ? '✓' : status === 'failure' ? '✗' : '…';
    print(`${pad(d)}${symbol} [${nodeType(node)}] ${node.name} (${round(durationMs)}ms)`);
  });

  on('node:error', ({ node, error }) => {
    const d = currentDepth(node) + 1;
    print(`${pad(d)}✗ [error] ${node.name}: ${error.message}`);
  });

  if (options.verbose) {
    on('agent:prompt', ({ node, prompt }) => {
      const d = currentDepth(node) + 1;
      const truncated = prompt.length > 120 ? prompt.slice(0, 117) + '...' : prompt;
      print(`${pad(d)}📋 [prompt] ${node.name}: ${truncated}`);
    });

    on('agent:thinking', ({ node, thinking }) => {
      const d = currentDepth(node) + 1;
      const firstLine = thinking.split('\n')[0];
      const truncated = firstLine.length > 100 ? firstLine.slice(0, 97) + '...' : firstLine;
      print(`${pad(d)}💭 [thinking] ${node.name}: ${truncated}`);
    });

    on('agent:tool_use', ({ node, tool }) => {
      const d = currentDepth(node) + 1;
      print(`${pad(d)}🔧 [tool] ${node.name}: ${tool}`);
    });
  }

  on('agent:response', ({ modelUsage: mu }) => {
    if (mu) mergeModelUsage(modelUsage, mu);
  });

  on('agent:error', ({ node, subtype, modelUsage: mu }) => {
    if (mu) mergeModelUsage(modelUsage, mu);
    const d = currentDepth(node) + 1;
    print(`${pad(d)}✗ [agent-error] ${node.name}: ${subtype}`);
  });

  on('tree:tick', ({ tree, status, durationMs }) => {
    print('');
    print(`Tree: ${tree} — ${status.toUpperCase()} (${round(durationMs)}ms)`);
    if (status === 'success' || status === 'failure') {
      for (const line of formatUsageSummary(modelUsage)) {
        print(line);
      }
    }
  });

  on('tree:abort', ({ tree }) => {
    print(`\nTree: ${tree} — ABORTED`);
  });

  return () => { for (const off of cleanup) off(); };
}

function round(ms: number): number {
  return Math.round(ms);
}

function mergeModelUsage(
  accumulated: Map<string, ModelUsage>,
  incoming: Record<string, ModelUsage>,
): void {
  for (const [model, usage] of Object.entries(incoming)) {
    const existing = accumulated.get(model);
    if (existing) {
      existing.inputTokens += usage.inputTokens;
      existing.outputTokens += usage.outputTokens;
      existing.cacheReadInputTokens += usage.cacheReadInputTokens;
      existing.cacheCreationInputTokens += usage.cacheCreationInputTokens;
      existing.webSearchRequests += usage.webSearchRequests;
      existing.costUSD += usage.costUSD;
      existing.contextWindow = Math.max(existing.contextWindow, usage.contextWindow);
      existing.maxOutputTokens = Math.max(existing.maxOutputTokens, usage.maxOutputTokens);
    } else {
      accumulated.set(model, { ...usage });
    }
  }
}

function formatUsageSummary(usage: Map<string, ModelUsage>): string[] {
  if (usage.size === 0) return [];

  const lines: string[] = ['', 'Usage:'];
  let totalCost = 0;

  for (const [model, u] of usage) {
    totalCost += u.costUSD;
    lines.push(`  ${model}`);

    const cacheParts: string[] = [];
    if (u.cacheReadInputTokens > 0) cacheParts.push(`cache read: ${fmt(u.cacheReadInputTokens)}`);
    if (u.cacheCreationInputTokens > 0) cacheParts.push(`cache write: ${fmt(u.cacheCreationInputTokens)}`);
    const cacheStr = cacheParts.length > 0 ? ` (${cacheParts.join(', ')})` : '';
    lines.push(`    Input:  ${fmt(u.inputTokens)} tokens${cacheStr}`);

    lines.push(`    Output: ${fmt(u.outputTokens)} tokens`);

    if (u.webSearchRequests > 0) {
      lines.push(`    Web searches: ${fmt(u.webSearchRequests)}`);
    }

    lines.push(`    Cost:   $${u.costUSD.toFixed(4)}`);
  }

  lines.push(`  Total: $${totalCost.toFixed(4)}`);
  return lines;
}

function fmt(n: number): string {
  return n.toLocaleString();
}
