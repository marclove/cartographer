# Task 113: Redis State Store Unit Tests — `src/state/redis-state-store.ts` (0% -> ~85%)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create unit tests for the RedisStateStore using a mocked ioredis client.

**Depends on:** None

---

### Context

`src/state/redis-state-store.ts` implements the `StateStore` interface backed by Redis. It handles state persistence (GET/SET), distributed locking (SET NX + Lua script), and event streaming (Redis Streams). Currently at 0% unit test coverage. The async iterable `readEvents` streaming path is complex and better suited for integration tests — focus unit tests on the synchronous/simple-async paths.

### Files

- Create: `src/state/redis-state-store.test.ts`
- Reference: `src/state/redis-state-store.ts` (source under test)
- Reference: `src/state/state-store.ts` (StateStore interface, TreeSessionState, TreeEvent types)
- Reference: `src/state/in-memory-state-store.test.ts` (test structure pattern)

### Approach

Create a mock ioredis object with `vi.fn()` stubs. The constructor takes a Redis client instance, so inject the mock directly. Skip the `readEvents` async iterable streaming path — that requires real Redis behavior and belongs in integration tests. Focus on: state CRUD, locking, event append, replay, and cleanup.

---

- [ ] **Step 1: Set up mock Redis client**

Create a factory that returns a mock Redis client with stubs for: `get`, `set`, `del`, `keys`, `eval`, `pipeline`, `xrange`, `xread`, `duplicate`, `quit`. The `pipeline()` mock returns an object with chainable `xadd`/`xtrim`/`exec` methods.

- [ ] **Step 2: Test state CRUD operations**

- `getState(key)` returns `null` when Redis returns `null`
- `getState(key)` returns parsed JSON when Redis returns a string
- `getState(key)` uses correct prefixed key format (`cartographer:<key>:state`)
- `saveState(key, state)` calls SET with JSON-serialized state
- `deleteState(key)` deletes both `<prefix>:<key>:state` and `<prefix>:<key>:events` keys
- `listKeys()` returns keys with prefix stripped

- [ ] **Step 3: Test locking operations**

- `acquireLock(key, requestId, ttlMs)` returns `true` when SET NX EX returns `'OK'`
- `acquireLock` returns `false` when SET NX EX returns `null` (lock held)
- `releaseLock(key, requestId)` calls `eval` with Lua script and correct args

- [ ] **Step 4: Test event operations**

- `appendEvents(key, events)` pipelines XADD for each event + XTRIM
- `readEvents(key)` replays existing events via XRANGE from `0`
- `readEvents(key, lastEventId)` replays from exclusive lastEventId via XRANGE

- [ ] **Step 5: Test lifecycle**

- `close()` calls `redis.quit()`
- Custom prefix is applied to all keys

- [ ] **Step 6: Run tests and verify coverage**

```bash
npx vitest run src/state/redis-state-store.test.ts
npx vitest run --config vitest.coverage.ts 2>&1 | grep "redis-state-store"
```

Expected: `src/state/redis-state-store.ts` coverage rises to ~85% (streaming path excluded).
