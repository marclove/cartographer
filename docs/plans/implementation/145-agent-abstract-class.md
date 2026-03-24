# Task 145: Agent Abstract Class and Types

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Define the abstract `Agent` class and all associated types (`AgentMessage`, `AgentConfig`, `AgentSendOptions`, `AgentInfo`, `AgentUsage`). This is the provider-agnostic interface that all agent implementations will extend.

**Architecture:** Pure type definitions and an abstract class with no concrete implementation. The abstract class enforces the contract: `send()`, `sessionId`, `getInfo()`, `close()`. A `TestAgent` helper is created in tests to validate the interface.

**Tech Stack:** TypeScript

**Spec:** `docs/superpowers/specs/2026-03-22-extract-agent-definition-design.md` — see "Abstract Agent Class" and "AgentMessage Types" sections.

---

### Step 1: Write failing tests

Create `packages/cartographer/src/agent/agent.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { Agent } from './agent.js';
import type { AgentMessage, AgentSendOptions, AgentInfo } from './agent.js';

class TestAgent extends Agent {
  private messages: AgentMessage[] = [];
  private _sessionId: string | null = null;

  setMessages(msgs: AgentMessage[]): void {
    this.messages = msgs;
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  async *send(prompt: string, options?: AgentSendOptions): AsyncIterable<AgentMessage> {
    this._sessionId = 'test-session-1';
    for (const msg of this.messages) {
      if (options?.onMessage) {
        try {
          options.onMessage(msg);
        } catch {
          // onMessage errors are swallowed per spec
        }
      }
      yield msg;
    }
  }

  getInfo(): AgentInfo {
    return { name: this.name, model: 'test-model' };
  }

  async close(): Promise<void> {
    this._sessionId = null;
  }
}

describe('Agent', () => {
  it('stores the name from config', () => {
    const agent = new TestAgent({ name: 'test-agent' });
    expect(agent.name).toBe('test-agent');
  });

  it('sessionId is null before first send', () => {
    const agent = new TestAgent({ name: 'test' });
    expect(agent.sessionId).toBeNull();
  });

  it('send() returns an async iterable of AgentMessages', async () => {
    const agent = new TestAgent({ name: 'test' });
    agent.setMessages([
      { type: 'text', content: 'hello' },
      { type: 'result', subtype: 'success', output: 'done' },
    ]);

    const messages: AgentMessage[] = [];
    for await (const msg of agent.send('prompt')) {
      messages.push(msg);
    }

    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ type: 'text', content: 'hello' });
    expect(messages[1]).toEqual({ type: 'result', subtype: 'success', output: 'done' });
  });

  it('sessionId is set after send', async () => {
    const agent = new TestAgent({ name: 'test' });
    agent.setMessages([{ type: 'result', subtype: 'success', output: 'ok' }]);

    for await (const _ of agent.send('prompt')) { /* consume */ }

    expect(agent.sessionId).toBe('test-session-1');
  });

  it('onMessage callback is invoked for each message', async () => {
    const agent = new TestAgent({ name: 'test' });
    agent.setMessages([
      { type: 'thinking', content: 'hmm' },
      { type: 'result', subtype: 'success', output: 'ok' },
    ]);

    const received: AgentMessage[] = [];
    for await (const _ of agent.send('prompt', {
      onMessage: (msg) => received.push(msg),
    })) { /* consume */ }

    expect(received).toHaveLength(2);
    expect(received[0].type).toBe('thinking');
  });

  it('onMessage errors do not crash iteration', async () => {
    const agent = new TestAgent({ name: 'test' });
    agent.setMessages([
      { type: 'text', content: 'hello' },
      { type: 'result', subtype: 'success', output: 'ok' },
    ]);

    const messages: AgentMessage[] = [];
    for await (const msg of agent.send('prompt', {
      onMessage: () => { throw new Error('handler error'); },
    })) {
      messages.push(msg);
    }

    expect(messages).toHaveLength(2);
  });

  it('getInfo() returns agent metadata', () => {
    const agent = new TestAgent({ name: 'my-agent' });
    const info = agent.getInfo();
    expect(info.name).toBe('my-agent');
    expect(info.model).toBe('test-model');
  });

  it('close() clears sessionId', async () => {
    const agent = new TestAgent({ name: 'test' });
    agent.setMessages([{ type: 'result', subtype: 'success', output: 'ok' }]);
    for await (const _ of agent.send('prompt')) { /* consume */ }
    expect(agent.sessionId).not.toBeNull();

    await agent.close();
    expect(agent.sessionId).toBeNull();
  });
});
```

### Step 2: Run test to verify it fails

Run: `pnpm --filter cartographer exec vitest run src/agent/agent.test.ts`
Expected: FAIL — cannot import `Agent`

### Step 3: Implement Agent abstract class and types

Create `packages/cartographer/src/agent/agent.ts`:

```typescript
import type { OnElicitation } from '@anthropic-ai/claude-agent-sdk';
import type { Blackboard } from '../core/blackboard.js';

/**
 * Configuration for constructing an Agent.
 */
export interface AgentConfig {
  /** Human-readable name for identification and debugging. */
  name: string;
}

/**
 * Per-invocation options passed to `Agent.send()`.
 */
export interface AgentSendOptions {
  /** Blackboard for agent access. Provider decides how to expose it. */
  blackboard?: Blackboard;
  /** Namespace for scoped blackboard access. */
  blackboardNamespace?: string;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** Elicitation handler for interactive input requests. */
  onElicitation?: OnElicitation;
  /**
   * Called for each AgentMessage as it is produced. Invoked for each
   * message before it is yielded by the returned iterable.
   *
   * The Agent catches and swallows errors thrown by this callback —
   * a failing handler must not crash the agent loop or starve
   * queued turns. Errors are emitted as provider_event messages
   * with subtype 'onMessage_error' so they remain observable.
   */
  onMessage?: (msg: AgentMessage) => void;
  /**
   * JSON schema for structured output. When set, the provider uses
   * native schema validation if available. Providers without native
   * support include the schema in the prompt and parse the result
   * text as JSON internally.
   *
   * This is a JSON Schema object, not a Zod schema. Callers using
   * Zod should convert via z.toJSONSchema() before calling.
   */
  outputSchema?: Record<string, unknown>;
}

/**
 * Provider-agnostic metadata for dashboard introspection.
 */
export interface AgentInfo {
  name: string;
  model?: string;
  tools?: string[];
  /** Provider-specific metadata beyond the common fields. */
  [key: string]: unknown;
}

/**
 * Token usage information from a completed turn.
 */
export interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  thoughtTokens?: number;
}

/**
 * Discriminated union of messages yielded by Agent.send().
 * Provider-agnostic — each concrete Agent maps its provider's
 * responses into these types.
 */
export type AgentMessage =
  | { type: 'thinking'; content: string }
  | { type: 'text'; content: string }
  | { type: 'tool_use'; name: string; input?: unknown }
  | { type: 'result'; subtype: 'success'; output: unknown; cost?: number; usage?: AgentUsage }
  | { type: 'result'; subtype: 'error'; errors?: unknown[]; cost?: number; usage?: AgentUsage }
  | { type: 'provider_event'; subtype: string; data: unknown };

/**
 * Abstract base class for all agent implementations.
 *
 * An Agent represents a configured AI agent that can process prompts
 * and stream responses. Concrete implementations wrap specific providers
 * (e.g., Claude SDK, ACP).
 *
 * The Agent's lifecycle is managed by its creator. Multiple BT nodes
 * and strategies may reference the same Agent instance. Each `send()`
 * call returns a scoped iterable for that turn's responses.
 */
export abstract class Agent {
  readonly name: string;

  constructor(config: AgentConfig) {
    this.name = config.name;
  }

  /** The active session ID, or null if no session has been created yet. */
  abstract get sessionId(): string | null;

  /**
   * Send a prompt and return an async iterable of response messages
   * scoped to this turn. Each call starts a new turn; conversation
   * history accumulates across turns within the same Agent instance.
   */
  abstract send(prompt: string, options?: AgentSendOptions): AsyncIterable<AgentMessage>;

  /** Return provider-agnostic metadata for dashboard introspection. */
  abstract getInfo(): AgentInfo;

  /** Clean up resources (e.g., SDK subprocess, ACP session). */
  abstract close(): Promise<void>;
}
```

### Step 4: Run test to verify it passes

Run: `pnpm --filter cartographer exec vitest run src/agent/agent.test.ts`
Expected: PASS (all 7 tests)

### Step 5: Commit

```bash
git add packages/cartographer/src/agent/agent.ts packages/cartographer/src/agent/agent.test.ts
git commit -m "feat(agent): add abstract Agent class with AgentMessage types"
```
