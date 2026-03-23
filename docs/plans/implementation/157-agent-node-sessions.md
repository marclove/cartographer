# Task 157: AgentNode Session Resolution

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add session support to `AgentNode` — resolve session config, pass session options to `agent.send()`, capture `session_start` messages and register them in the `SessionRegistry`.

**Depends on:** Task 154 (SessionRegistry), Task 155 (Agent session types), Task 156 (BehaviorTree sessions)

**Spec Reference:** `docs/superpowers/specs/2026-03-23-agent-sessions-design.md` — AgentNode Configuration, AgentNode Tick Lifecycle sections

---

### Step 1: Add SessionConfig type to types.ts

Modify `src/types.ts` — add before `AgentNodeConfig` (around line 660):

```ts
/**
 * Configuration for how an AgentNode participates in a named session.
 *
 * Three modes:
 * - `{ name: "triage" }` — Resume: append to the named session.
 * - `{ name: "triage", fork: true }` — Anonymous fork: read context, work is ephemeral.
 * - `{ name: "triage", fork: "billing-thread" }` — Named fork: branch into a new named session.
 */
export interface SessionConfig {
  /** The named session to participate in. */
  name: string;
  /**
   * Fork behavior. When `true`, creates an anonymous fork (ephemeral).
   * When a string, creates a named fork registered under that name.
   * When absent or `undefined`, the agent resumes (appends to) the session.
   */
  fork?: true | string;
}
```

Add `session` field to `AgentNodeConfig` (after the `cache` field, around line 697):

```ts
  /**
   * Named session participation. When set, the agent shares conversation
   * history with other agents using the same session name.
   *
   * Shorthand: `session: "triage"` is equivalent to `session: { name: "triage" }`.
   *
   * Three modes:
   * - `"triage"` or `{ name: "triage" }` — Resume the named session.
   * - `{ name: "triage", fork: true }` — Anonymous fork (context only, ephemeral).
   * - `{ name: "triage", fork: "billing-thread" }` — Named fork (new session from parent).
   */
  session?: string | SessionConfig;
```

### Step 2: Write failing tests

Add a new `describe('sessions', ...)` block in `src/nodes/agent.test.ts`:

```ts
import { SessionRegistry } from '../core/session-registry.js';

describe('AgentNode - sessions', () => {
  function makeContext(overrides?: Partial<TreeContext>): TreeContext {
    return {
      blackboard: new InMemoryBlackboard(),
      events: new EventEmitter<TreeEvents>(),
      sessions: new SessionRegistry(),
      ...overrides,
    };
  }

  it('registers a new session when resuming a session that does not exist yet', async () => {
    const agent = createTestAgent([
      { type: 'result', subtype: 'success', output: 'done' },
    ]);
    const node = new AgentNode({
      name: 'classify',
      agent,
      prompt: 'classify this',
      session: 'triage',
    });

    const context = makeContext();
    await node.tick(context); // RUNNING
    await flush();
    await node.tick(context); // SUCCESS

    expect(context.sessions.has('triage')).toBe(true);
    expect(context.sessions.get('triage')).toEqual(expect.any(String));
  });

  it('passes the existing session ID when resuming a session that exists', async () => {
    const sentOptions: any[] = [];
    const agent = createTestAgent([
      { type: 'result', subtype: 'success', output: 'done' },
    ]);
    const originalSend = agent.send.bind(agent);
    agent.send = function(prompt: string, options?: any) {
      sentOptions.push(options);
      return originalSend(prompt, options);
    };

    const node = new AgentNode({
      name: 'billing',
      agent,
      prompt: 'analyze billing',
      session: 'triage',
    });

    const context = makeContext();
    context.sessions.set('triage', 'existing-session-id');

    await node.tick(context); // RUNNING
    await flush();
    await node.tick(context); // SUCCESS

    expect(sentOptions[0]?.session).toEqual({ id: 'existing-session-id' });
  });

  it('passes fork option when forking an existing session', async () => {
    const sentOptions: any[] = [];
    const agent = createTestAgent([
      { type: 'result', subtype: 'success', output: 'done' },
    ]);
    const originalSend = agent.send.bind(agent);
    agent.send = function(prompt: string, options?: any) {
      sentOptions.push(options);
      return originalSend(prompt, options);
    };

    const node = new AgentNode({
      name: 'billing',
      agent,
      prompt: 'analyze billing',
      session: { name: 'triage', fork: true },
    });

    const context = makeContext();
    context.sessions.set('triage', 'parent-session-id');

    await node.tick(context);
    await flush();
    await node.tick(context);

    expect(sentOptions[0]?.session).toEqual({ id: 'parent-session-id', fork: true });
  });

  it('registers a named fork under the fork name', async () => {
    const agent = createTestAgent([
      { type: 'result', subtype: 'success', output: 'done' },
    ]);
    const node = new AgentNode({
      name: 'billing',
      agent,
      prompt: 'analyze billing',
      session: { name: 'triage', fork: 'billing-thread' },
    });

    const context = makeContext();
    context.sessions.set('triage', 'parent-session-id');

    await node.tick(context);
    await flush();
    await node.tick(context);

    // Named fork should be registered under the fork name
    expect(context.sessions.has('billing-thread')).toBe(true);
    // Original session should be unchanged
    expect(context.sessions.get('triage')).toBe('parent-session-id');
  });

  it('does not register an anonymous fork', async () => {
    const agent = createTestAgent([
      { type: 'result', subtype: 'success', output: 'done' },
    ]);
    const node = new AgentNode({
      name: 'billing',
      agent,
      prompt: 'analyze billing',
      session: { name: 'triage', fork: true },
    });

    const context = makeContext();
    context.sessions.set('triage', 'parent-session-id');

    await node.tick(context);
    await flush();
    await node.tick(context);

    // Only the original session should exist
    expect(context.sessions.get('triage')).toBe('parent-session-id');
  });

  it('returns FAILURE when forking a session that does not exist', async () => {
    const agent = createTestAgent([
      { type: 'result', subtype: 'success', output: 'done' },
    ]);
    const node = new AgentNode({
      name: 'billing',
      agent,
      prompt: 'analyze billing',
      session: { name: 'nonexistent', fork: true },
    });

    const context = makeContext();

    // resolveSessionOptions throws synchronously inside execute(),
    // BaseNode.tick() catches it and returns FAILURE on the first tick.
    const status = await node.tick(context);
    expect(status).toBe(NodeStatus.FAILURE);
  });

  it('does not use the session registry when no session config is set', async () => {
    const agent = createTestAgent([
      { type: 'result', subtype: 'success', output: 'done' },
    ]);
    const node = new AgentNode({
      name: 'standalone',
      agent,
      prompt: 'do something',
    });

    const context = makeContext();

    await node.tick(context);
    await flush();
    await node.tick(context);

    // No sessions should have been registered
    expect(context.sessions.toRecord()).toEqual({});
  });

  it('accepts string shorthand for session config', async () => {
    const agent = createTestAgent([
      { type: 'result', subtype: 'success', output: 'done' },
    ]);
    const node = new AgentNode({
      name: 'classify',
      agent,
      prompt: 'classify',
      session: 'triage', // shorthand
    });

    const context = makeContext();
    await node.tick(context);
    await flush();
    await node.tick(context);

    expect(context.sessions.has('triage')).toBe(true);
  });
});
```

Note: `flush()` is a test helper that lets microtasks settle. Check how existing agent.test.ts implements it — likely `await new Promise(r => setTimeout(r, 0))` or similar.

### Step 3: Run tests to verify they fail

Run: `pnpm --filter cartographer exec vitest run src/nodes/agent.test.ts`

Expected: FAIL — `session` does not exist on `AgentNodeConfig`.

### Step 4: Implement session resolution in AgentNode

Modify `src/nodes/agent.ts`:

Add import for `AgentSessionOptions`:

```ts
import type { AgentMessage, AgentInfo, AgentSessionOptions } from '../agent/agent.js';
```

Add import for `SessionConfig`:

```ts
import type { AgentNodeConfig, BTreeNode, TreeContext, SessionConfig } from '../types.js';
```

Add a public getter for validation (after `agentOptions` getter, around line 63):

```ts
  /** Normalized session config, or null if this node doesn't participate in a named session. */
  get sessionConfig(): SessionConfig | null {
    if (!this.config.session) return null;
    return typeof this.config.session === 'string'
      ? { name: this.config.session }
      : this.config.session;
  }
```

Add a private method to resolve session options (after `emitAgentEvent`, at the end of the class):

```ts
  /**
   * Resolve the node's session config into AgentSessionOptions for send().
   * Returns undefined if no session config is set (agent manages its own session).
   */
  private resolveSessionOptions(context: TreeContext): AgentSessionOptions | undefined {
    const config = this.sessionConfig;
    if (!config) return undefined;

    const registry = context.sessions;

    if (config.fork) {
      const existingId = registry.get(config.name);
      if (!existingId) {
        throw new Error(
          `Cannot fork session "${config.name}": session does not exist. ` +
          `Ensure an agent resumes this session before another agent forks it.`,
        );
      }
      return { id: existingId, fork: true };
    }

    const existingId = registry.get(config.name);
    return existingId ? { id: existingId } : {};
  }

  /**
   * Register the session ID from a session_start message in the registry.
   */
  private registerSession(context: TreeContext, sessionId: string): void {
    const config = this.sessionConfig;
    if (!config) return;

    if (typeof config.fork === 'string') {
      // Named fork — register under the fork name
      context.sessions.set(config.fork, sessionId);
    } else if (!config.fork) {
      // Resume — register under the session name
      context.sessions.set(config.name, sessionId);
    }
    // Anonymous fork (fork: true) — don't register
  }
```

Modify `execute()` to resolve session options and pass them to `_executeAgentCall`. Change the start path (around line 158):

```ts
    // Start path: kick off the agent call in the background
    const sessionOpts = this.resolveSessionOptions(context);
    const state: { promise: Promise<NodeStatus>; result?: NodeStatus; error?: Error } = {
      promise: this._executeAgentCall(context, sessionOpts),
    };
```

Modify `_executeAgentCall` signature and body to accept and use session options:

```ts
  private async _executeAgentCall(
    context: TreeContext,
    sessionOpts?: AgentSessionOptions,
  ): Promise<NodeStatus> {
    const prompt = typeof this.config.prompt === 'function'
      ? this.config.prompt(context)
      : this.config.prompt;

    context.events.emit('agent:prompt', { node: this, prompt });

    const messages = this.config.agent.send(prompt, {
      blackboard: context.blackboard,
      blackboardNamespace: this.config.blackboardNamespace,
      signal: context.signal,
      onElicitation: context.onElicitation,
      onMessage: (msg) => this.emitAgentEvent(msg, context),
      session: sessionOpts,
    });

    for await (const msg of messages) {
      if (msg.type === 'session_start') {
        this.registerSession(context, msg.sessionId);
        continue;
      }

      if (msg.type === 'result') {
        if (msg.subtype === 'success') {
          return this.handleSuccess(msg.output, msg.cost, context);
        }

        context.events.emit('agent:error', {
          node: this,
          subtype: 'error',
          errors: (msg.errors ?? []) as string[],
          cost: msg.cost,
        });
        return NodeStatus.FAILURE;
      }
    }

    return NodeStatus.FAILURE;
  }
```

### Step 5: Run tests to verify they pass

Run: `pnpm --filter cartographer exec vitest run src/nodes/agent.test.ts`

Expected: All pass.

### Step 6: Run full test suite

Run: `pnpm --filter cartographer test`

Expected: All pass.

### Step 7: Typecheck

Run: `pnpm typecheck`

### Step 8: Commit

```bash
git add packages/cartographer/src/types.ts packages/cartographer/src/nodes/agent.ts packages/cartographer/src/nodes/agent.test.ts
git commit -m "feat(agent-node): add session resolution and registry integration"
```
