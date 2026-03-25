import type { IncomingMessage, ServerResponse } from 'node:http';
import type { EventStream } from './event-stream.js';

export type SseClient = ServerResponse;

export interface SseSnapshot {
  /** The snapshot payload sent as the first SSE event. */
  data: unknown;
  /** The event ID to attach to the snapshot event. */
  id: string;
}

export interface SseStreamOptions {
  /**
   * When `true`, replay the entire event buffer on initial connect (not just
   * on reconnect). Useful when clients need to see events that occurred before
   * they connected. Default: `false`.
   */
  replayOnConnect?: boolean;
}

export function handleSseStream(
  req: IncomingMessage,
  res: ServerResponse,
  snapshot: SseSnapshot,
  eventStream: EventStream,
  sseClients: Set<SseClient>,
  options?: SseStreamOptions,
): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // Send initial snapshot
  sendSseEvent(res, 'snapshot', snapshot.data, snapshot.id);

  // Replay missed events on reconnect, or the entire buffer on initial connect
  const lastEventId = req.headers['last-event-id'] as string | undefined;
  const sinceId = lastEventId ?? (options?.replayOnConnect ? '0' : undefined);
  if (sinceId !== undefined) {
    const events = eventStream.replaySince(sinceId);
    if (events === null) {
      // Buffer gap — send a full snapshot instead
      sendSseEvent(res, 'snapshot', snapshot.data, snapshot.id);
    } else {
      for (const event of events) {
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

