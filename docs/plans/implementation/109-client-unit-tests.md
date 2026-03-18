# Task 109: Client Unit Test Coverage — `src/client/index.ts` (31% -> ~90%)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Expand unit test coverage for the CartographerClient, covering all HTTP methods, error handling, and event routing.

**Depends on:** None

---

### Context

`src/client/index.ts` exports `createCartographerClient()` which is the primary SDK for consumers. Currently at 31.5% coverage with only 4 tests covering `action()`, `blackboard()`, `status()`, and `ConflictError`. Critical methods like `write()`, `send()`, error paths, and event routing are entirely untested.

### Files

- Modify: `src/client/index.test.ts`
- Reference: `src/client/index.ts` (source under test)
- Reference: `src/client/types.ts` (ConflictError, CartographerClient type)
- Reference: `src/server/actor-server.ts` (test server pattern)

### Pattern

Follow existing pattern in `src/client/index.test.ts` — spin up a real `ActorServer` on port 0 for HTTP tests.

---

- [ ] **Step 1: Add HTTP method tests**

Add to existing describe block in `src/client/index.test.ts`:

- `write(key, value)` — POSTs to `/api/blackboard/:key` with `{ value }` body, verify key appears in subsequent `blackboard()` call
- `send(msg)` — POSTs to `/api/messages` with a tick message, returns `{ id }`
- `tree()` — returns GET `/api/tree` response with tree name and root

- [ ] **Step 2: Add error handling tests**

These require the server to return specific status codes:

- `action()` throws `ConflictError` on 409 — send two concurrent actions to trigger conflict
- `action()` throws on 400 — send an action with invalid payload (e.g., send a message with missing `type` field via `send()` to trigger validation)
- `action()` throws "Server is shutting down" on 503 — call `server.stop()` then attempt an action

- [ ] **Step 3: Add event listener tests**

Test the `on()`/`off()`/`onAny()` dispatch mechanism. These don't need a server — they test internal listener management:

- `on(event, handler)` registers handler; dispatching that event calls it
- `off(event, handler)` removes handler; dispatching no longer calls it
- `onAny(handler)` receives all dispatched events with type and data

For dispatch testing, either:
- Use a real server + SSE connection and trigger events via message processing
- Or test the listener mechanism in isolation by connecting to a real server's `/api/events` endpoint and verifying events arrive

- [ ] **Step 4: Add connect/disconnect tests**

- `connect()` is a no-op when `EventSource` is undefined (default Node.js without flag)
- `connect()` when already connected doesn't create a second connection
- `disconnect()` clears the connection (subsequent `connect()` creates a new one)

- [ ] **Step 5: Run tests and verify coverage**

```bash
npx vitest run src/client/index.test.ts
npx vitest run --config vitest.coverage.ts 2>&1 | grep "src/client"
```

Expected: `src/client/index.ts` coverage rises to ~90% statements.
