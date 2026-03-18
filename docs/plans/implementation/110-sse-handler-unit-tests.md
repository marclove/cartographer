# Task 110: SSE Handler Unit Tests — `src/server/sse-handler.ts` (37% -> ~95%)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create unit tests for all 4 exported functions in the SSE handler module.

**Depends on:** None

---

### Context

`src/server/sse-handler.ts` exports `handleSseStream`, `broadcastSseEvent`, `sendSseEvent`, and `blackboardToRecord`. Integration tests exist in `src/__integration__/sse-stream.test.ts` but no unit tests exercise these functions directly. At 37% coverage, this is the lowest-covered server module.

### Files

- Create: `src/server/sse-handler.test.ts`
- Reference: `src/server/sse-handler.ts` (source under test — 82 lines)
- Reference: `src/server/event-buffer.ts` (EventBuffer type, BufferedEvent type)
- Reference: `src/server/serializers.ts` (serializeTree used internally)

### Approach

Mock `ServerResponse` with `vi.fn()` stubs for `writeHead`/`write`. Mock `IncomingMessage` with configurable headers. Mock `EventBuffer` with controlled `getEventsSince`/`latestId`. Create a minimal tree-like object with a `root` and `blackboard`.

---

- [ ] **Step 1: Test `sendSseEvent`**

- Writes correct SSE wire format: `id: <id>\n`, `event: <event>\n`, `data: <json>\n\n`
- Calls `res.write()` exactly 3 times (id line, event line, data line with trailing double newline)
- JSON-serializes the data parameter

- [ ] **Step 2: Test `blackboardToRecord`**

- Uses `toRecord()` shortcut when the blackboard has it
- Falls back to iterating `keys()` + `get()` when `toRecord` is not a function
- Returns correct key-value pairs in both paths

- [ ] **Step 3: Test `broadcastSseEvent`**

- Sends event to all clients in the set
- With empty client set, no writes occur
- With multiple clients, each receives the event

- [ ] **Step 4: Test `handleSseStream`**

- Sets SSE response headers (Content-Type: text/event-stream, Cache-Control: no-cache, Connection: keep-alive)
- Sends initial snapshot event with serialized tree and blackboard
- Replays missed events when `Last-Event-ID` header is present and `getEventsSince` returns events
- Sends full snapshot on buffer gap (`getEventsSince` returns null)
- No replay when `Last-Event-ID` header is absent
- Adds client to `sseClients` set
- Removes client from `sseClients` set when request `close` event fires

- [ ] **Step 5: Run tests and verify coverage**

```bash
npx vitest run src/server/sse-handler.test.ts
npx vitest run --config vitest.coverage.ts 2>&1 | grep "sse-handler"
```

Expected: `src/server/sse-handler.ts` coverage rises to ~95%.
