import type { IncomingMessage, ServerResponse } from 'node:http';
import type { BehaviorTree } from '../core/behavior-tree.js';
import type { EventStream } from './event-stream.js';
import { serializeTree } from './serializers.js';

export type SseClient = ServerResponse;

export function handleSseStream(
  req: IncomingMessage,
  res: ServerResponse,
  tree: BehaviorTree,
  eventStream: EventStream,
  sseClients: Set<SseClient>,
): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // Send initial snapshot
  const snapshot = {
    tree: serializeTree(tree.root),
    blackboard: blackboardToRecord(tree.blackboard),
  };
  sendSseEvent(res, 'snapshot', snapshot, eventStream.latestId);

  // Replay missed events on reconnect
  const lastEventId = req.headers['last-event-id'];
  if (lastEventId) {
    const missed = eventStream.replaySince(lastEventId as string);
    if (missed === null) {
      // Buffer gap — send a full snapshot instead
      sendSseEvent(res, 'snapshot', snapshot, eventStream.latestId);
    } else {
      for (const event of missed) {
        sendSseEvent(res, event.event, event.data, event.id);
      }
    }
  }

  // Subscribe to live events
  const unsubscribe = eventStream.subscribe((entry) => {
    sendSseEvent(res, entry.event, entry.data, entry.id);
  });

  sseClients.add(res);

  req.on('close', () => {
    unsubscribe();
    sseClients.delete(res);
  });
}

export function sendSseEvent(
  res: ServerResponse,
  event: string,
  data: unknown,
  id: string,
): void {
  res.write(`id: ${id}\n`);
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function blackboardToRecord(bb: { keys(): string[]; get<T>(key: string): T | undefined; toRecord?(): Record<string, unknown> }): Record<string, unknown> {
  if (typeof bb.toRecord === 'function') {
    return bb.toRecord();
  }
  const record: Record<string, unknown> = {};
  for (const key of bb.keys()) {
    record[key] = bb.get(key);
  }
  return record;
}
