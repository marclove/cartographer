# Task 108: ClaudeSDKAgent Query-per-Send Refactor

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refactor `ClaudeSDKAgent` from a long-lived single-query model to query-per-send. Each `send()` call creates a fresh SDK `query()` with appropriate session resume/fork options. Remove the `AsyncQueue`, demux loop, and pending turns machinery.

**Depends on:** Task 103 (Agent session types)

**Spec Reference:** `docs/superpowers/specs/2026-03-23-agent-sessions-design.md` — ClaudeSDKAgent Refactor section

---

### Important: Read the current code first

Before implementing, read these files thoroughly:
- `src/agent/claude-sdk-agent.ts` — The current implementation (~460 lines)
- `src/agent/claude-sdk-agent.test.ts` — The existing test suite
- `src/agent/async-queue.ts` — AsyncQueue used by the current implementation

Understand the mock setup in tests — `vi.mock('@anthropic-ai/claude-code')` — and how SDK messages are simulated. The existing tests set up the `query` mock to return an async iterable of SDK messages.

### Step 1: Write failing tests for session support

Add new tests to `src/agent/claude-sdk-agent.test.ts`:

```ts
describe('session support', () => {
  it('emits session_start with the session ID from SDK init message', async () => {
    // Mock query to return an init message and a result
    vi.mocked(query).mockReturnValue(mockQuery([
      { type: 'system', subtype: 'init', session_id: 'sdk-session-123', /* ... */ },
      { type: 'result', subtype: 'success', result: 'done', cost_usd: 0, duration_ms: 0, duration_api_ms: 0, is_error: false, num_turns: 1, session_id: 'sdk-session-123' },
    ]));

    const agent = new ClaudeSDKAgent({ name: 'test' });
    const messages: AgentMessage[] = [];
    for await (const msg of agent.send('hello')) {
      messages.push(msg);
    }

    expect(messages[0]).toEqual({ type: 'session_start', sessionId: 'sdk-session-123' });
  });

  it('creates a fresh query per send call', async () => {
    vi.mocked(query).mockReturnValue(mockQuery([
      { type: 'system', subtype: 'init', session_id: 'session-1' },
      { type: 'result', subtype: 'success', result: 'r1', cost_usd: 0, duration_ms: 0, duration_api_ms: 0, is_error: false, num_turns: 1, session_id: 'session-1' },
    ]));

    const agent = new ClaudeSDKAgent({ name: 'test' });

    for await (const _ of agent.send('first')) {}
    for await (const _ of agent.send('second')) {}

    // query() should have been called twice — once per send
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('resumes the private session on subsequent sends without session options', async () => {
    vi.mocked(query).mockReturnValue(mockQuery([
      { type: 'system', subtype: 'init', session_id: 'private-session' },
      { type: 'result', subtype: 'success', result: 'done', cost_usd: 0, duration_ms: 0, duration_api_ms: 0, is_error: false, num_turns: 1, session_id: 'private-session' },
    ]));

    const agent = new ClaudeSDKAgent({ name: 'test' });

    for await (const _ of agent.send('first')) {}

    // Reset mock for second call
    vi.mocked(query).mockReturnValue(mockQuery([
      { type: 'system', subtype: 'init', session_id: 'private-session' },
      { type: 'result', subtype: 'success', result: 'done', cost_usd: 0, duration_ms: 0, duration_api_ms: 0, is_error: false, num_turns: 1, session_id: 'private-session' },
    ]));

    for await (const _ of agent.send('second')) {}

    // Second call should resume the private session
    const secondCallOpts = vi.mocked(query).mock.calls[1][0].options;
    expect(secondCallOpts?.resume).toBe('private-session');
  });

  it('passes session.id as resume when provided', async () => {
    vi.mocked(query).mockReturnValue(mockQuery([
      { type: 'system', subtype: 'init', session_id: 'named-session' },
      { type: 'result', subtype: 'success', result: 'done', cost_usd: 0, duration_ms: 0, duration_api_ms: 0, is_error: false, num_turns: 1, session_id: 'named-session' },
    ]));

    const agent = new ClaudeSDKAgent({ name: 'test' });
    for await (const _ of agent.send('hello', { session: { id: 'named-session' } })) {}

    const callOpts = vi.mocked(query).mock.calls[0][0].options;
    expect(callOpts?.resume).toBe('named-session');
    expect(callOpts?.forkSession).toBeUndefined();
  });

  it('passes forkSession when forking', async () => {
    vi.mocked(query).mockReturnValue(mockQuery([
      { type: 'system', subtype: 'init', session_id: 'forked-session' },
      { type: 'result', subtype: 'success', result: 'done', cost_usd: 0, duration_ms: 0, duration_api_ms: 0, is_error: false, num_turns: 1, session_id: 'forked-session' },
    ]));

    const agent = new ClaudeSDKAgent({ name: 'test' });
    for await (const _ of agent.send('hello', { session: { id: 'parent-session', fork: true } })) {}

    const callOpts = vi.mocked(query).mock.calls[0][0].options;
    expect(callOpts?.resume).toBe('parent-session');
    expect(callOpts?.forkSession).toBe(true);
  });

  it('creates new session (no resume) when session options have no id', async () => {
    vi.mocked(query).mockReturnValue(mockQuery([
      { type: 'system', subtype: 'init', session_id: 'new-session' },
      { type: 'result', subtype: 'success', result: 'done', cost_usd: 0, duration_ms: 0, duration_api_ms: 0, is_error: false, num_turns: 1, session_id: 'new-session' },
    ]));

    const agent = new ClaudeSDKAgent({ name: 'test' });
    for await (const _ of agent.send('hello', { session: {} })) {}

    const callOpts = vi.mocked(query).mock.calls[0][0].options;
    expect(callOpts?.resume).toBeUndefined();
  });

  it('sets persistSession to false', async () => {
    vi.mocked(query).mockReturnValue(mockQuery([
      { type: 'system', subtype: 'init', session_id: 'session' },
      { type: 'result', subtype: 'success', result: 'done', cost_usd: 0, duration_ms: 0, duration_api_ms: 0, is_error: false, num_turns: 1, session_id: 'session' },
    ]));

    const agent = new ClaudeSDKAgent({ name: 'test' });
    for await (const _ of agent.send('hello')) {}

    const callOpts = vi.mocked(query).mock.calls[0][0].options;
    expect(callOpts?.persistSession).toBe(false);
  });

  it('does not change private session when explicit session options are used', async () => {
    // First send — no session options, creates private session
    vi.mocked(query).mockReturnValue(mockQuery([
      { type: 'system', subtype: 'init', session_id: 'private-id' },
      { type: 'result', subtype: 'success', result: 'r', cost_usd: 0, duration_ms: 0, duration_api_ms: 0, is_error: false, num_turns: 1, session_id: 'private-id' },
    ]));

    const agent = new ClaudeSDKAgent({ name: 'test' });
    for await (const _ of agent.send('first')) {}

    // Second send — explicit session
    vi.mocked(query).mockReturnValue(mockQuery([
      { type: 'system', subtype: 'init', session_id: 'explicit-id' },
      { type: 'result', subtype: 'success', result: 'r', cost_usd: 0, duration_ms: 0, duration_api_ms: 0, is_error: false, num_turns: 1, session_id: 'explicit-id' },
    ]));
    for await (const _ of agent.send('second', { session: { id: 'explicit-id' } })) {}

    // Third send — no session options, should resume private session, not explicit
    vi.mocked(query).mockReturnValue(mockQuery([
      { type: 'system', subtype: 'init', session_id: 'private-id' },
      { type: 'result', subtype: 'success', result: 'r', cost_usd: 0, duration_ms: 0, duration_api_ms: 0, is_error: false, num_turns: 1, session_id: 'private-id' },
    ]));
    for await (const _ of agent.send('third')) {}

    const thirdCallOpts = vi.mocked(query).mock.calls[2][0].options;
    expect(thirdCallOpts?.resume).toBe('private-id');
  });
});
```

Note: Adapt the mock helper (`mockQuery`) to match the existing test patterns. The existing tests likely have a helper that creates an async iterable from an array of SDK messages.

### Step 2: Run tests to verify they fail

Run: `pnpm --filter cartographer exec vitest run src/agent/claude-sdk-agent.test.ts`

Expected: FAIL — current implementation doesn't create per-send queries, doesn't emit session_start, etc.

### Step 3: Rewrite ClaudeSDKAgent to query-per-send

Replace the core of `src/agent/claude-sdk-agent.ts`. The new implementation:

**Remove:**
- `AsyncQueue` import and usage
- `messageQueue` field
- `pendingTurns` array
- `activeTurnResolve`, `activeTurnReject`, `activeTurnDone`, `activeTurnSignalCleanup` fields
- `demuxRunning` flag
- `_activeTurnOnMessage` field
- `ensureDemuxLoop()` method
- `runDemuxLoop()` method
- `wireSignalToInterrupt()` method
- `clearActiveTurn()` method

**Keep:**
- `config` field
- `_sessionId` getter (returns last session ID)
- `getInfo()` method
- `mapSdkMessage()` method (refactored — see below)
- Constructor validation (reserved "blackboard" MCP server check)

**New fields:**
- `_privateSessionId: string | null = null`
- `_activeQuery: ReturnType<typeof query> | null = null`
- `_closed = false`

**New `send()` method:**

```ts
  send(prompt: string, options?: AgentSendOptions): AsyncIterable<AgentMessage> {
    const agent = this;
    return {
      [Symbol.asyncIterator]() {
        return agent._createSendIterator(prompt, options);
      },
    };
  }

  private async *_createSendIterator(
    prompt: string,
    options?: AgentSendOptions,
  ): AsyncGenerator<AgentMessage> {
    if (this._closed) throw new Error('Agent is closed');

    const sessionOpts = options?.session;
    const resumeId = sessionOpts ? sessionOpts.id : this._privateSessionId;

    const queryOpts = this.buildQueryOptions(prompt, options);
    const queryInstance = query({
      prompt,
      options: {
        ...queryOpts,
        persistSession: false,
        ...(resumeId ? { resume: resumeId } : {}),
        ...(resumeId && sessionOpts?.fork ? { forkSession: true } : {}),
      },
    });

    this._activeQuery = queryInstance;

    try {
      for await (const message of queryInstance) {
        if (message.type === 'system' && message.subtype === 'init') {
          const sessionId = message.session_id;
          this._sessionId = sessionId;

          if (!sessionOpts) {
            this._privateSessionId = sessionId;
          }

          // Yield session_start first (for AgentNode registry integration)
          yield { type: 'session_start', sessionId };

          // Also yield the mapped provider_event so agent:init events
          // continue to fire (sessionId, model, tools, etc.)
          const mapped = this.mapSdkMessage(message);
          for (const msg of mapped) {
            if (options?.onMessage) {
              try { options.onMessage(msg); } catch { /* swallowed per spec */ }
            }
            yield msg;
          }
          continue;
        }

        const mapped = this.mapSdkMessage(message);
        for (const msg of mapped) {
          if (options?.onMessage) {
            try { options.onMessage(msg); } catch { /* swallowed per spec */ }
          }
          yield msg;
        }
      }
    } finally {
      this._activeQuery = null;
    }
  }
```

**Refactor `createQuery()` into `buildQueryOptions()`:**

Extract the option-building logic from the current `createQuery()` method into a `buildQueryOptions()` that returns the Options object without creating the query.

**Important:** Preserve all existing behaviors from `createQuery()`:
- `permissionMode` defaulting (check existing code for the default value)
- `$schema` stripping from config-level `outputFormat` (not just `sendOptions.outputSchema`)
- The auto-decline elicitation handler must emit a `provider_event` with subtype `elicitation_declined` (check the existing handler logic and replicate it exactly)

The pseudocode below is simplified — cross-reference with the actual `createQuery()` implementation and preserve any logic not shown here:

```ts
  private buildQueryOptions(prompt: string, sendOptions?: AgentSendOptions): Partial<Options> {
    const { name, ...configOpts } = this.config;

    // Build MCP servers dict
    const mcpServers: Record<string, any> = { ...configOpts.mcpServers };
    if (sendOptions?.blackboard) {
      const server = createBlackboardMcpServer(
        sendOptions.blackboardNamespace
          ? sendOptions.blackboard.scoped(sendOptions.blackboardNamespace)
          : sendOptions.blackboard,
        sendOptions.blackboardNamespace,
      );
      mcpServers.blackboard = server;
    }

    // Auto-decline elicitation handler
    const onElicitation = sendOptions?.onElicitation ?? (async (request) => {
      // emit provider_event for declined elicitation
      return { action: 'deny' as const, message: 'Auto-declined: no elicitation handler provided' };
    });

    // Output format
    let outputFormat = configOpts.outputFormat;
    if (sendOptions?.outputSchema) {
      const { $schema, ...schema } = sendOptions.outputSchema as Record<string, unknown>;
      outputFormat = { type: 'json_schema', schema };
    }

    const allowedTools = [...(configOpts.allowedTools ?? [])];
    if (mcpServers.blackboard) {
      allowedTools.push('mcp__blackboard__*');
    }

    return {
      ...configOpts,
      mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
      allowedTools: allowedTools.length > 0 ? allowedTools : undefined,
      onElicitation,
      outputFormat,
      signal: sendOptions?.signal,
    };
  }
```

**New `close()` method:**

```ts
  async close(): Promise<void> {
    this._closed = true;
    if (this._activeQuery) {
      this._activeQuery.close();
      this._activeQuery = null;
    }
  }
```

**Note on `mapSdkMessage()`:** The existing method returns `AgentMessage[]` (an array). In the new iterator, use `for (const msg of mapped)` to yield each. Alternatively, refactor to return a single message if the multiple-message case only applies to `assistant` type (which contains thinking, text, tool_use blocks). Keep the existing logic but adapt the calling code.

### Step 4: Update existing tests

The query-per-send refactor fundamentally changes how the SDK mock works. **Every existing test must be reviewed.** Key changes:

1. **Mock setup:** The current tests set up `query` to return a single async iterable. This still works — each `send()` creates a new `query()` call, so each test's mock setup feeds one send. But tests that call `send()` multiple times need to set up the mock return value before each send (use `mockReturnValueOnce` or reset between sends).

2. **Init message is now required in every mock:** Every `send()` call expects a `system.init` message from the SDK to extract the session ID. Existing tests that don't include an init message will still work (no session_start is emitted if no init message arrives), but tests verifying the full message flow should include one.

3. **`session_start` appears in the message stream:** Tests that collect all messages from `send()` will now see `session_start` as the first message (when an init message is present). Update assertions that check message counts or first-message types.

4. **`onMessage` receives mapped init events but NOT `session_start`:** The `onMessage` callback is invoked for mapped SDK messages (including the `provider_event` from the init message) but not for the synthetic `session_start` message. Verify existing onMessage tests still pass.

5. **No more multi-turn queueing:** Tests that previously tested multiple `send()` calls going through the same query now test multiple separate queries. If any test relied on conversation-level state accumulating within a single query, it needs to verify that `resume` is passed on the second call instead.

6. **Constructor no longer creates a query:** The query is created per-send, not lazily on first send via the demux loop. Remove any test that verifies lazy query creation or demux initialization.

### Step 5: Run tests

Run: `pnpm --filter cartographer exec vitest run src/agent/claude-sdk-agent.test.ts`

Expected: All pass.

### Step 6: Remove AsyncQueue

Delete `src/agent/async-queue.ts` and `src/agent/async-queue.test.ts` (if it exists). Remove any imports of AsyncQueue from the codebase.

Run: `pnpm --filter cartographer test`

Expected: All pass. If other code imports AsyncQueue, update those imports.

### Step 7: Run full test suite

Run: `pnpm test`

Expected: All pass across the monorepo.

### Step 8: Typecheck

Run: `pnpm typecheck`

### Step 9: Commit

```bash
git add packages/cartographer/src/agent/claude-sdk-agent.ts packages/cartographer/src/agent/claude-sdk-agent.test.ts
git rm packages/cartographer/src/agent/async-queue.ts
# Also rm async-queue.test.ts if it exists
git commit -m "refactor(agent): rewrite ClaudeSDKAgent to query-per-send model with session support"
```
