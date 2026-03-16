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

#### `action(name: string, payload?: unknown): Promise<{ id: string }>`

Sends an action message. Shorthand for `POST /api/actions/:name`.

#### `write(key: string, value: unknown): Promise<{ id: string }>`

Writes a value to the blackboard. Shorthand for `POST /api/blackboard/:key`.

#### `send(msg: object): Promise<{ id: string }>`

Sends any message type via `POST /api/messages`.

#### `actionAndWait(name: string, payload?: unknown): Promise<{ messageId, treeStatus }>`

Sends an action and waits for the corresponding `message:processed` or `message:failed` event via SSE. Requires `connect()` to be called first.

### Control Methods

#### `interrupt(): Promise<{ interrupted: boolean; messageId?: string }>`

Interrupts the currently processing message. Bypasses the lock. Returns `{ interrupted: true, messageId }` if processing was active, `{ interrupted: false }` if idle. Calls `POST /api/interrupt`.

#### `resume(): Promise<{ resumed: boolean }>`

Clears the held state so the next tick processes normally. Returns `{ resumed: true }` if the tree was held, `{ resumed: false }` if not. Calls `POST /api/resume`.

#### `interruptAndAction(name: string, payload?: unknown): Promise<{ id: string }>`

Convenience method that interrupts the current processing, waits for the lock to release, then sends a new action. The action clears the held state implicitly.

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

Opens an `EventSource` connection to `GET /api/events`. No-op if already connected. In Node.js, requires an `EventSource` polyfill (e.g., the `eventsource` package). If `globalThis.EventSource` is undefined, `connect()` silently returns without error. This means `actionAndWait()` will hang indefinitely in environments without `EventSource` — ensure the polyfill is loaded before calling `connect()`.

#### `disconnect(): void`

Closes the SSE connection.

---

## ConflictError

```typescript
import { ConflictError } from 'cartographer';
```

Thrown when the server returns `409 Conflict` (another message is being processed).

```typescript
class ConflictError extends Error {
  name: 'ConflictError';
  message: 'Session is currently processing a message';
}
```
