import type { TypedEventEmitter, TreeEvents, BTreeNode } from '../types.js';

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

  on('agent:response', ({ node, result, cost }) => {
    write({ event: 'agent:response', node: node.name, result, cost });
  });

  on('agent:error', ({ node, subtype, errors: errs, cost }) => {
    write({ event: 'agent:error', node: node.name, subtype, errors: errs, cost });
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
  let depth = 0;
  const depthStack: BTreeNode[] = [];

  function on<K extends keyof TreeEvents & string>(
    event: K,
    handler: (data: TreeEvents[K]) => void,
  ): void {
    events.on(event, handler);
    cleanup.push(() => events.off(event, handler));
  }

  function indent(): string {
    return '  '.repeat(depth);
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

  on('node:enter', ({ node }) => {
    print(`${indent()}▶ [${nodeType(node)}] ${node.name}`);
    depthStack.push(node);
    depth++;
  });

  on('node:exit', ({ node, status, durationMs }) => {
    depth = Math.max(0, depth - 1);
    depthStack.pop();
    const symbol = status === 'success' ? '✓' : status === 'failure' ? '✗' : '…';
    print(`${indent()}${symbol} [${nodeType(node)}] ${node.name} (${round(durationMs)}ms)`);
  });

  on('node:error', ({ node, error }) => {
    print(`${indent()}✗ [error] ${node.name}: ${error.message}`);
  });

  if (options.verbose) {
    on('agent:prompt', ({ node, prompt }) => {
      const truncated = prompt.length > 120 ? prompt.slice(0, 117) + '...' : prompt;
      print(`${indent()}📋 [prompt] ${node.name}: ${truncated}`);
    });

    on('agent:thinking', ({ node, thinking }) => {
      const firstLine = thinking.split('\n')[0];
      const truncated = firstLine.length > 100 ? firstLine.slice(0, 97) + '...' : firstLine;
      print(`${indent()}💭 [thinking] ${node.name}: ${truncated}`);
    });

    on('agent:tool_use', ({ node, tool }) => {
      print(`${indent()}🔧 [tool] ${node.name}: ${tool}`);
    });
  }

  on('agent:error', ({ node, subtype }) => {
    print(`${indent()}✗ [agent-error] ${node.name}: ${subtype}`);
  });

  on('tree:tick', ({ tree, status, durationMs }) => {
    print('');
    print(`Tree: ${tree} — ${status.toUpperCase()} (${round(durationMs)}ms)`);
  });

  on('tree:abort', ({ tree }) => {
    print(`\nTree: ${tree} — ABORTED`);
  });

  return () => { for (const off of cleanup) off(); };
}

function round(ms: number): number {
  return Math.round(ms);
}
