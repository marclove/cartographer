# Task 155: Agent Session Types + TestAgent

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add session-related types to the Agent interface (`AgentSessionOptions`, `session_start` message) and update `TestAgent` to support them.

**Depends on:** None

**Spec Reference:** `docs/superpowers/specs/2026-03-23-agent-sessions-design.md` — Agent Interface Changes section

---

### Step 1: Write failing tests for TestAgent session support

Create `src/agent/test-agent.test.ts` (this is a **new file** — no existing test file for TestAgent):

```ts
import { describe, it, expect } from 'vitest';
import { TestAgent, createTestAgent } from './test-agent.js';
import type { AgentMessage } from './agent.js';

describe('TestAgent', () => {
  describe('session_start emission', () => {
    it('emits session_start as the first message', async () => {
      const agent = createTestAgent([
        { type: 'result', subtype: 'success', output: 'done' },
      ]);
      const messages: AgentMessage[] = [];
      for await (const msg of agent.send('hello')) {
        messages.push(msg);
      }
      expect(messages[0]).toEqual(
        expect.objectContaining({ type: 'session_start' }),
      );
      expect((messages[0] as any).sessionId).toEqual(expect.any(String));
    });

    it('generates a stable private session ID across sends without session options', async () => {
      const agent = createTestAgent([
        { type: 'result', subtype: 'success', output: 'done' },
      ]);

      const first: AgentMessage[] = [];
      for await (const msg of agent.send('hello')) first.push(msg);

      const second: AgentMessage[] = [];
      for await (const msg of agent.send('hello again')) second.push(msg);

      const id1 = (first[0] as any).sessionId;
      const id2 = (second[0] as any).sessionId;
      expect(id1).toBe(id2); // same private session
    });
  });

  describe('session options', () => {
    it('uses the provided session ID when resuming', async () => {
      const agent = createTestAgent([
        { type: 'result', subtype: 'success', output: 'done' },
      ]);
      const messages: AgentMessage[] = [];
      for await (const msg of agent.send('hello', { session: { id: 'existing-session' } })) {
        messages.push(msg);
      }
      expect((messages[0] as any).sessionId).toBe('existing-session');
    });

    it('generates a new session ID when forking', async () => {
      const agent = createTestAgent([
        { type: 'result', subtype: 'success', output: 'done' },
      ]);
      const messages: AgentMessage[] = [];
      for await (const msg of agent.send('hello', { session: { id: 'parent-session', fork: true } })) {
        messages.push(msg);
      }
      const sessionId = (messages[0] as any).sessionId;
      expect(sessionId).not.toBe('parent-session');
      expect(sessionId).toEqual(expect.any(String));
    });

    it('generates a new session ID when session options have no id (first use of named session)', async () => {
      const agent = createTestAgent([
        { type: 'result', subtype: 'success', output: 'done' },
      ]);
      const messages: AgentMessage[] = [];
      for await (const msg of agent.send('hello', { session: {} })) {
        messages.push(msg);
      }
      expect((messages[0] as any).sessionId).toEqual(expect.any(String));
    });

    it('does not change the private session ID when using explicit session options', async () => {
      const agent = createTestAgent([
        { type: 'result', subtype: 'success', output: 'done' },
      ]);

      // First send with no session options — creates private session
      const first: AgentMessage[] = [];
      for await (const msg of agent.send('hello')) first.push(msg);
      const privateId = (first[0] as any).sessionId;

      // Second send with explicit session — should NOT affect private session
      for await (const _msg of agent.send('hello', { session: { id: 'other' } })) {}

      // Third send with no session options — should still use the same private session
      const third: AgentMessage[] = [];
      for await (const msg of agent.send('hello')) third.push(msg);
      expect((third[0] as any).sessionId).toBe(privateId);
    });
  });

  describe('onMessage callback', () => {
    it('does not invoke onMessage for session_start messages', async () => {
      const agent = createTestAgent([
        { type: 'result', subtype: 'success', output: 'done' },
      ]);
      const received: AgentMessage[] = [];
      for await (const _msg of agent.send('hello', {
        onMessage: (msg) => received.push(msg),
      })) {}
      // onMessage should NOT receive session_start — only user-facing messages
      expect(received.every(m => m.type !== 'session_start')).toBe(true);
    });
  });
});
```

### Step 2: Run tests to verify they fail

Run: `pnpm --filter cartographer exec vitest run src/agent/test-agent.test.ts`

Expected: FAIL — `session_start` type does not exist, `session` option not on `AgentSendOptions`.

### Step 3: Add types to agent.ts

Modify `src/agent/agent.ts`:

Add `AgentSessionOptions` interface after `AgentSendOptions` (after line 44):

```ts
/**
 * Session options for Agent.send().
 *
 * Controls whether the agent creates a new session, resumes an existing
 * session, or forks from one. These options are provider-agnostic —
 * each concrete Agent maps them to its provider's session API.
 */
export interface AgentSessionOptions {
  /** Provider session ID to resume. When undefined, a new session is created. */
  id?: string;
  /** Fork from the session instead of appending to it. Requires `id` to be set. */
  fork?: boolean;
}
```

Add `session` field to `AgentSendOptions` (inside the interface, after `outputSchema`):

```ts
  /**
   * Session options controlling which conversation to resume, fork, or create.
   * When omitted, the agent manages its own private session.
   */
  session?: AgentSessionOptions;
```

Add `session_start` variant to `AgentMessage` union (after line 78):

```ts
  | { type: 'session_start'; sessionId: string }
```

### Step 4: Update TestAgent to support sessions

Replace the `send` method in `src/agent/test-agent.ts` (lines 31-38) with:

```ts
  private _sessionCounter = 0;
  private _privateSessionId: string | null = null;

  async *send(_prompt: string, options?: AgentSendOptions): AsyncIterable<AgentMessage> {
    const sessionOpts = options?.session;
    let sessionId: string;

    if (!sessionOpts) {
      // Private session — stable across sends
      if (!this._privateSessionId) {
        this._privateSessionId = `test-session-${++this._sessionCounter}`;
      }
      sessionId = this._privateSessionId;
    } else if (sessionOpts.id && !sessionOpts.fork) {
      // Resume: use provided ID
      sessionId = sessionOpts.id;
    } else {
      // New session or fork: generate new ID
      sessionId = `test-session-${++this._sessionCounter}`;
    }

    this._sessionId = sessionId;
    yield { type: 'session_start', sessionId };

    for (const msg of this.messages) {
      if (options?.onMessage) {
        try { options.onMessage(msg); } catch { /* swallowed per spec */ }
      }
      yield msg;
    }
  }
```

Also remove the `this._sessionId = 'test-session';` line that was previously at the top of `send()` — it's now handled by the session logic.

### Step 5: Update emitAgentEvent in AgentNode to skip session_start

Modify `src/nodes/agent.ts` — add a case for `session_start` in the `emitAgentEvent` switch (at line 241, inside the switch):

```ts
      case 'session_start':
        // Handled by _executeAgentCall — not forwarded as a BT event
        break;
```

### Step 6: Run tests to verify they pass

Run: `pnpm --filter cartographer exec vitest run src/agent/test-agent.test.ts`

Expected: All pass.

### Step 7: Run existing tests to check for regressions

Run: `pnpm --filter cartographer test`

Expected: All pass. The `session_start` message is now emitted by `TestAgent` before the user-defined messages, so tests that check message sequences need to account for it. If any existing tests fail because they receive an unexpected `session_start` as the first message, update those tests to skip or filter it.

The main tests likely to be affected are in `src/nodes/agent.test.ts` — the `for await` loop in `_executeAgentCall` will now encounter `session_start` before `result` messages. Since `_executeAgentCall` only acts on `msg.type === 'result'`, the `session_start` message is harmlessly iterated over. Verify this is the case.

### Step 8: Typecheck

Run: `pnpm typecheck`

### Step 9: Commit

```bash
git add packages/cartographer/src/agent/agent.ts packages/cartographer/src/agent/test-agent.ts packages/cartographer/src/agent/test-agent.test.ts packages/cartographer/src/nodes/agent.ts
git commit -m "feat(agent): add session types to Agent interface and TestAgent"
```
