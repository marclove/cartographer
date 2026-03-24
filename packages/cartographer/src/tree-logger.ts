import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TypedEventEmitter, TreeEvents } from './types.js';

export interface TreeLoggerOptions {
  /**
   * Path to the log file. Entries are appended in NDJSON format (one JSON
   * object per line). The file is created if it does not exist.
   */
  filePath: string;

  /**
   * Include `blackboard:write` events in the log.
   *
   * Defaults to `false` — blackboard writes can be very frequent in large
   * trees and would dominate the log file.
   */
  logBlackboard?: boolean;

  /**
   * Include `strategy:decision` events in the log.
   *
   * Defaults to `true`.
   */
  logStrategy?: boolean;
}

/**
 * Subscribe to tree events and append structured log entries to a file.
 *
 * All meaningful events are logged. The two exceptions are:
 * - `agent:stream` — raw streaming deltas (partial tokens); too noisy.
 * - `agent:message` — the catch-all raw SDK message; redundant with the
 *   other `agent:*` events.
 *
 * Log entries are written as NDJSON (newline-delimited JSON), one object per
 * line, so the file can be parsed incrementally, piped to `jq`, or tailed
 * in a terminal:
 *
 * ```sh
 * tail -f run.log | jq .
 * tail -f run.log | jq 'select(.event == "agent:tool_use")'
 * ```
 *
 * @param events - The tree event emitter to attach to.
 * @param options - Logger configuration.
 * @returns A cleanup function that removes all listeners. Call it when the
 *   tree is done to prevent memory leaks.
 *
 * @example
 * ```ts
 * const events = new EventEmitter<TreeEvents>();
 * const tree = new BehaviorTree({ root, blackboard, events });
 *
 * const stopLogging = createTreeLogger(events, { filePath: './run.log' });
 * await tree.tick();
 * stopLogging();
 * ```
 */
export function createTreeLogger(
  events: TypedEventEmitter<TreeEvents>,
  options: TreeLoggerOptions,
): () => void {
  const { filePath, logBlackboard = false, logStrategy = true } = options;
  let seq = 0;

  // Ensure the destination directory exists before the first write.
  mkdirSync(dirname(filePath), { recursive: true });

  function write(entry: Record<string, unknown>): void {
    appendFileSync(
      filePath,
      JSON.stringify({ ts: new Date().toISOString(), seq: ++seq, ...entry }) + '\n',
    );
  }

  // Collect off-functions so the returned cleanup removes every listener.
  const cleanup: Array<() => void> = [];

  function on<K extends keyof TreeEvents & string>(
    event: K,
    handler: (data: TreeEvents[K]) => void,
  ): void {
    events.on(event, handler);
    cleanup.push(() => events.off(event, handler));
  }

  // --- Node lifecycle ---

  on('node:enter', ({ node }) => {
    write({ event: 'node:enter', node: node.name, nodeId: node.id });
  });

  on('node:exit', ({ node, status, durationMs }) => {
    write({ event: 'node:exit', node: node.name, nodeId: node.id, status, durationMs });
  });

  on('node:error', ({ node, error }) => {
    write({ event: 'node:error', node: node.name, nodeId: node.id, error: error.message, stack: error.stack });
  });

  // --- Agent events ---

  on('agent:prompt', ({ node, prompt }) => {
    write({ event: 'agent:prompt', node: node.name, nodeId: node.id, prompt });
  });

  on('agent:thinking', ({ node, thinking }) => {
    write({ event: 'agent:thinking', node: node.name, nodeId: node.id, thinking });
  });

  on('agent:text', ({ node, text }) => {
    write({ event: 'agent:text', node: node.name, nodeId: node.id, text });
  });

  on('agent:tool_use', ({ node, tool, input }) => {
    write({ event: 'agent:tool_use', node: node.name, nodeId: node.id, tool, input });
  });

  on('agent:response', ({ node, result, cost }) => {
    write({ event: 'agent:response', node: node.name, nodeId: node.id, result, cost });
  });

  on('agent:error', ({ node, subtype, errors, permissionDenials, cost }) => {
    write({ event: 'agent:error', node: node.name, nodeId: node.id, subtype, errors, permissionDenials, cost });
  });

  on('agent:tool_progress', ({ node, toolUseId, toolName, elapsedSeconds }) => {
    write({ event: 'agent:tool_progress', node: node.name, nodeId: node.id, toolUseId, toolName, elapsedSeconds });
  });

  on('agent:init', ({ node, sessionId, model, tools, mcpServers }) => {
    write({ event: 'agent:init', node: node.name, nodeId: node.id, sessionId, model, tools, mcpServers });
  });

  on('agent:status', ({ node, status }) => {
    write({ event: 'agent:status', node: node.name, nodeId: node.id, status });
  });

  on('agent:rate_limit', ({ node, info }) => {
    write({ event: 'agent:rate_limit', node: node.name, nodeId: node.id, info });
  });

  // --- Tree lifecycle ---

  on('tree:init', ({ tree, root }) => {
    write({ event: 'tree:init', tree, root });
  });

  on('tree:tick', ({ tree, status, durationMs }) => {
    write({ event: 'tree:tick', tree, status, durationMs });
  });

  on('tree:reset', ({ tree }) => {
    write({ event: 'tree:reset', tree });
  });

  on('tree:abort', ({ tree }) => {
    write({ event: 'tree:abort', tree });
  });

  // --- Data events (opt-in) ---

  if (logBlackboard) {
    on('blackboard:write', ({ key, value, source }) => {
      write({ event: 'blackboard:write', key, value, source });
    });
  }

  if (logStrategy) {
    on('strategy:decision', ({ composite, strategy, decision }) => {
      write({ event: 'strategy:decision', composite: composite.name, compositeId: composite.id, strategy, decision });
    });
  }

  return () => {
    for (const off of cleanup) off();
  };
}
