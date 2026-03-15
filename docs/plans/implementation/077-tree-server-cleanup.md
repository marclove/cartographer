# Task 77: TreeServer Cleanup

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove dashboard-specific concerns from the TreeServer: static file serving, `EXCLUDED_EVENTS`, and the hardcoded event name list. The TreeServer becomes a pure API + SSE server that dynamically broadcasts all tree events.

**Depends on:** Task 75, Task 76

---

### Step 1: Update existing test to verify 404 on non-API routes

Edit `src/server/tree-server.test.ts` — add a new test case:

```ts
  it('returns 404 for non-API, non-SSE routes', async () => {
    const tree = createTestTree();
    server = new TreeServer(tree, { port: 0 });
    const { port } = await server.start();

    const res = await fetch(`http://localhost:${port}/index.html`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'Not found', status: 404 });
  });
```

### Step 2: Run the new test to see current behavior

Run: `npx vitest run src/server/tree-server.test.ts`
Expected: The new test may pass (static file serving returns 404 when the file doesn't exist) or fail. Either way, it establishes the expected behavior after cleanup.

### Step 3: Remove static file serving from TreeServer

Edit `src/server/tree-server.ts`:

Remove these imports (they are only used for static file serving):
- `import { join, extname } from 'node:path';`
- `import { readFile } from 'node:fs/promises';`
- `import { fileURLToPath } from 'node:url';`

Remove the `CONTENT_TYPES` constant.

Remove the `serveStaticFile` private method entirely.

In `handleRequest`, replace the static file fallback at the end:

```ts
    // Static file serving
    this.serveStaticFile(pathname, res);
```

with:

```ts
    jsonError(res, 404, 'Not found');
```

Also add the missing import for `jsonError` if not already imported after Task 76:

```ts
import { jsonError } from './http-utils.js';
```

### Step 4: Remove EXCLUDED_EVENTS

Edit `src/server/tree-server.ts`:

Delete the `EXCLUDED_EVENTS` constant:

```ts
/** Events that are too noisy or too large to broadcast to clients. */
const EXCLUDED_EVENTS: ReadonlySet<keyof TreeEvents> = new Set(['agent:stream']);
```

Also remove the `import type { TreeEvents } from '../types.js';` if it is no longer used anywhere in the file (check — it may still be used by `subscribeToEvents`). After step 5 it will no longer be needed.

Keep the `import { NodeStatus } from '../types.js';` — it is still used by the `onTick` handler.

### Step 5: Replace hardcoded event list with onAny

Edit `src/server/tree-server.ts` — replace the entire `subscribeToEvents` method:

```ts
  private subscribeToEvents(): void {
    // Track tick stats
    const onTick = (data: TreeEvents['tree:tick']) => {
      this.state.tickCount++;
      this.state.lastStatus = data.status;
      if (data.status !== NodeStatus.RUNNING) {
        this.state.cycleCount++;
      }
      this.state.lastDurationMs = data.durationMs;
    };
    this.tree.events.on('tree:tick', onTick);
    this.unsubscribers.push(() => this.tree.events.off('tree:tick', onTick));

    // Forward all events to SSE clients
    const onAnyEvent = (event: string, data: unknown) => {
      const serialized = serializeEvent(event as any, data);
      const entry = this.eventBuffer.push(event, serialized);
      broadcastSseEvent(this.sseClients, entry);
    };
    this.tree.events.onAny(onAnyEvent);
    this.unsubscribers.push(() => this.tree.events.offAny(onAnyEvent));
  }
```

This replaces both the hardcoded event name array and the `EXCLUDED_EVENTS` filter with a single `onAny` subscription. The `tree:tick` listener remains separate because it needs to update internal state, not just forward events. It keeps the typed `TreeEvents['tree:tick']` annotation and `NodeStatus.RUNNING` comparison for type safety.

### Step 6: Clean up unused imports

After the above changes, review the imports at the top of `tree-server.ts` and remove anything no longer needed:

- Remove `import { NodeStatus } from '../types.js';` (the tick handler now compares `data.status !== 'running'` as a string, matching the serialized value)
- Remove `import type { TreeEvents } from '../types.js';` (no longer referenced)

The remaining imports should be:

```ts
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import type { BehaviorTree } from '../core/behavior-tree.js';
import { NodeStatus } from '../types.js';
import type { TreeEvents } from '../types.js';
import { EventBuffer } from './event-buffer.js';
import { serializeEvent } from './serializers.js';
import { handleApiTree, handleApiStatus, handleApiBlackboard, handleApiNode } from './api-handlers.js';
import type { StatusState } from './api-handlers.js';
import { handleSseStream, broadcastSseEvent } from './sse-handler.js';
import type { SseClient } from './sse-handler.js';
import { jsonError } from './http-utils.js';
```

Note: `NodeStatus` and `TreeEvents` are retained for the typed `onTick` handler.

### Step 7: Typecheck

Run: `npm run typecheck`
Expected: All pass.

### Step 8: Run unit tests

Run: `npm run test`
Expected: All pass.

### Step 9: Run integration tests

Run: `npm run test:integration`
Expected: All pass. The SSE stream test should still work — the `onAny` subscription forwards the same events as before (and more, since `agent:stream` is no longer excluded).

### Step 10: Commit

```bash
git add src/server/tree-server.ts src/server/tree-server.test.ts
git commit -m "refactor(server): remove static serving and event exclusions, use onAny for dynamic subscription"
```
