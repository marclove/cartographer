# Client SDK API Reference

## createCartographerClient

```typescript
import { createCartographerClient } from 'cartographer';

const client = createCartographerClient(baseUrl: string): CartographerClient;
```

Creates a client connected to an `ActorServer` at the given URL.

---

## CartographerClient

### Message Methods

#### `command(name: string, payload?: unknown): Promise<SendResponse>`

Sends a command message. Shorthand for `POST /api/commands/:name`.

#### `write(key: string, value: unknown): Promise<SendResponse>`

Writes a value to the blackboard. Shorthand for `POST /api/blackboard/:key`.

#### `send(msg: object): Promise<SendResponse>`

Sends any message type via `POST /api/messages`.

All three methods return a `SendResponse` with `status: 'processing'` when the message is being processed immediately, or `status: 'queued'` with a `position` when the server is busy and the message was enqueued.

#### `commandAndWait(name: string, payload?: unknown): Promise<{ messageId, treeStatus }>`

Sends a command and waits for the corresponding `message:processed` or `message:failed` event via SSE. Requires `connect()` to be called first.

### Control Methods

#### `interrupt(): Promise<{ interrupted: boolean; messageId?: string }>`

Interrupts the currently processing message. Bypasses the lock. Returns `{ interrupted: true, messageId }` if processing was active, `{ interrupted: false }` if idle. Calls `POST /api/interrupt`.

#### `resume(): Promise<{ resumed: boolean }>`

Clears the held state so the next tick processes normally. Returns `{ resumed: true }` if the tree was held, `{ resumed: false }` if not. Calls `POST /api/resume`.

#### `interruptAndCommand(name: string, payload?: unknown): Promise<{ id: string }>`

Convenience method that interrupts the current processing, waits for the lock to release, then sends a new command. The command clears the held state implicitly.

If nothing is being processed (`interrupted === false`), the command is sent immediately without waiting. If processing was active, the method waits for the interrupted message's `message:processed` or `message:failed` SSE event before sending the follow-up command. This requires `connect()` to have been called first (same requirement as `commandAndWait()`).

### Read Methods

#### `blackboard(): Promise<Record<string, unknown>>`

Returns the current blackboard state.

#### `tree(): Promise<unknown>`

Returns tree structure metadata.

#### `status(): Promise<unknown>`

Returns tree status metadata.

### Event Methods

#### `on(event: string, handler: (data: unknown) => void): void`

Subscribe to a specific event type. For `client:event` events, you can also subscribe by the event name (e.g., `client.on('ui:show_review', handler)`).

#### `onAny(handler: (event: string, data: unknown) => void): void`

Subscribe to all events.

#### `off(event: string, handler: (data: unknown) => void): void`

Unsubscribe a handler.

### SSE Lifecycle

#### `connect(): void`

Opens an `EventSource` connection to `GET /api/events`. No-op if already connected. In Node.js, requires an `EventSource` polyfill (e.g., the `eventsource` package) or the `--experimental-eventsource` flag (Node 22+). If `globalThis.EventSource` is undefined, `connect()` silently returns without error. This means `commandAndWait()` and `interruptAndCommand()` (when processing is active) will hang indefinitely in environments without `EventSource` — ensure EventSource is available before calling `connect()`.

#### `disconnect(): void`

Closes the SSE connection.

---

## SendResponse

```typescript
interface SendResponse {
  id: string;
  status?: 'processing' | 'queued';
  position?: number;
}
```

Returned by `command()`, `write()`, and `send()`. When the server processes the message immediately, `status` is `'processing'`. When the server is busy and the message is enqueued, `status` is `'queued'` and `position` indicates the message's place in the queue (1-based).

---

## QueueFullError

```typescript
import { QueueFullError } from '@cartographer/client';
```

Thrown when the server returns `429` because the message queue is full. This only happens when the server is processing a message and the queue has reached its configured `maxQueueDepth`.

```typescript
class QueueFullError extends Error {
  name: 'QueueFullError';
  message: 'Server message queue is full';
}
```
