# Agent Sessions Design

Named, shared sessions that allow multiple agent definitions to participate in the same conversation history within a single tree run.

## Context

The Claude Agent SDK provides session management that enables conversation history to persist across and be shared between `query()` calls. A new query can resume a previous session with entirely different config (model, tools, system prompt, output format) while inheriting the conversation context. The Agent Communication Protocol (ACP) provides equivalent primitives: `session/new`, `session/prompt`, `session/load`, and `session/fork`.

Cartographer's current architecture has each `ClaudeSDKAgent` instance owning exactly one long-lived `query()` call. Conversation history accumulates within that single query. There is no mechanism for multiple agents to share conversation context or for an agent to see another agent's reasoning beyond what's written to the blackboard.

## Goals

1. Multiple agent definitions (potentially with different models, tools, and output schemas) can share conversation history through named sessions.
2. A tree where an initial "classify" agent examines input and downstream agents can see the classify agent's full conversation context, not just the blackboard output.
3. Multi-cycle trees where the same agent node remembers what happened in previous ticks within the same tree run.
4. Session semantics are provider-agnostic, mapping cleanly to both the Claude SDK and ACP.

## Design

### Named Sessions

Sessions are first-class, named objects scoped to a single tree run. A session represents a named conversation transcript that any `AgentNode`, regardless of its location within the tree, can use and append to.

- Sessions are identified by name (a string).
- Any number of `AgentNode` instances can reference the same session name.
- Sessions are implicitly created when the first agent resumes a session name that doesn't exist yet.
- When the tree reaches a terminal state (SUCCESS or FAILURE), all named sessions are cleared. The next tree run starts with blank sessions.
- Sessions that return RUNNING preserve all session state across ticks.

### SessionRegistry

A lightweight map from session names to provider session IDs, added to `TreeContext`:

```typescript
class SessionRegistry {
  private sessions = new Map<string, string>()

  get(name: string): string | undefined
  set(name: string, id: string): void
  has(name: string): boolean
  reset(): void

  toRecord(): Record<string, string>
  static fromRecord(data: Record<string, string>): SessionRegistry
}
```

```typescript
interface TreeContext {
  blackboard: Blackboard
  events: TypedEventEmitter<TreeEvents>
  signal?: AbortSignal
  onElicitation?: OnElicitation
  sessions: SessionRegistry  // new
}
```

### Agent Interface Changes

`AgentSendOptions` gains a `session` field:

```typescript
interface AgentSessionOptions {
  id?: string       // provider session ID to resume (undefined = create new)
  fork?: boolean    // fork from the session instead of appending
}

interface AgentSendOptions {
  blackboard?: Blackboard
  signal?: AbortSignal
  onElicitation?: OnElicitation
  onMessage?: (msg: AgentMessage) => void
  outputSchema?: JsonSchema
  session?: AgentSessionOptions  // new
}
```

A new `AgentMessage` variant communicates the session ID back to the caller:

```typescript
| { type: 'session_start'; sessionId: string }
```

This is emitted as the first message in every `send()` stream. The return type remains `AsyncIterable<AgentMessage>`, but the `AgentMessage` discriminated union is extended with the new variant. This is a breaking change for consumers that exhaustively switch on `msg.type` — all existing switch/if-else chains (including `emitAgentEvent` in `AgentNode` and `onMessage` callbacks) must handle or skip the new `session_start` type. `AgentNode._executeAgentCall` captures it for registry updates and does not forward it to `emitAgentEvent`.

The existing `sessionId` getter on the `Agent` abstract class remains, returning the session ID from the most recent send.

### AgentNode Configuration

`AgentNodeConfig` gains a `session` field with three modes:

```typescript
interface AgentNodeConfig {
  name: string
  agent: Agent
  prompt: string | ((context: TreeContext) => string)
  blackboardNamespace?: string
  mapResult?: (output: unknown, context: TreeContext) => NodeStatus
  cache?: boolean
  session?: string | SessionConfig  // new
}

interface SessionConfig {
  name: string
  fork?: true | string  // true = anonymous fork, string = named fork
}
```

The three modes:

| Configuration | Behavior |
|---|---|
| `session: "triage"` | Resume: append to named session "triage" |
| `session: { name: "triage", fork: true }` | Anonymous fork: read context from "triage", work is ephemeral |
| `session: { name: "triage", fork: "billing-thread" }` | Named fork: branch "triage" into new named session "billing-thread" |

Shorthand: `session: "triage"` normalizes to `{ name: "triage" }` (resume mode).

### AgentNode Tick Lifecycle

The `execute()` method changes to resolve session options before calling `agent.send()`:

1. Resolve session config (normalize shorthand to `SessionConfig`).
2. Look up session in registry:
   - **Resume, session exists**: `sendOptions.session = { id: registry.get(name) }`
   - **Resume, session doesn't exist**: `sendOptions.session = {}` — agent creates a new session; node registers the returned session ID.
   - **Fork, session exists**: `sendOptions.session = { id: registry.get(name), fork: true }`
   - **Fork, session doesn't exist**: Runtime error — cannot fork a session that hasn't been created yet.
   - **No session config**: `sendOptions.session` is undefined — agent manages its own private session.
3. Call `agent.send(prompt, sendOptions)`.
4. Capture `session_start` message from the stream:
   - Resume mode: `registry.set(name, sessionId)`
   - Named fork: `registry.set(forkName, sessionId)`
   - Anonymous fork: don't register (ephemeral).
5. Rest of tick lifecycle unchanged (inflight state, blackboard write, event emission).

RUNNING continuity: when a node returns RUNNING and is ticked again, the inflight state holds the active send. No session lookup on polling ticks.

### ClaudeSDKAgent Refactor: Query-per-Send

The core change: each `send()` call creates a fresh SDK `query()` instead of reusing a long-lived one.

**Removed:**
- `AsyncQueue` — no message queuing between turns
- Demux loop — each query handles exactly one turn
- `pendingTurns` array — no turn multiplexing
- `messageQueue` field, `demuxRunning` flag, `activeTurnResolve` callback

**New model:**

```typescript
class ClaudeSDKAgent extends Agent {
  private readonly config: ClaudeSDKAgentConfig
  private _privateSessionId: string | null = null
  private _activeQuery: Query | null = null
  private _closed = false

  send(prompt: string, options?: AgentSendOptions): AsyncIterable<AgentMessage> {
    const agent = this
    return {
      [Symbol.asyncIterator]() {
        return agent._createSendIterator(prompt, options)
      }
    }
  }

  private async *_createSendIterator(
    prompt: string,
    options?: AgentSendOptions
  ): AsyncGenerator<AgentMessage> {
    const sessionOpts = options?.session
    // Distinguish "no session options" (use private session) from
    // "session options with no id" (create new named session)
    const resumeId = sessionOpts
      ? sessionOpts.id            // explicit session — undefined means "create new"
      : this._privateSessionId    // no session config — use private session

    const baseOpts = this.buildQueryOptions(prompt, options)
    const queryInstance = query({
      prompt,
      options: {
        ...baseOpts,
        persistSession: false,  // Cartographer manages persistence via StateStore
        ...(resumeId && { resume: resumeId }),
        ...(resumeId && sessionOpts?.fork && { forkSession: true }),
      },
    })

    this._activeQuery = queryInstance

    try {
      for await (const message of queryInstance) {
        if (message.type === 'system' && message.subtype === 'init') {
          const sessionId = message.session_id

          if (!sessionOpts) {
            this._privateSessionId = sessionId
          }

          yield { type: 'session_start', sessionId }
          continue
        }

        yield this.mapSdkMessage(message)
      }
    } finally {
      this._activeQuery = null
    }
  }

  async close(): Promise<void> {
    this._closed = true
    this._activeQuery?.close()
    this._activeQuery = null
  }
}
```

The `send()` method returns a manually constructed `AsyncIterable` (not an `async *` generator directly) to match the abstract class return type. The actual generator logic lives in `_createSendIterator`.

Key behaviors:
- **No session options, first send**: Fresh query, SDK assigns session ID, stored as `_privateSessionId`.
- **No session options, subsequent sends**: Query with `resume: _privateSessionId` — conversation continues.
- **Resume named session**: Query with `resume: id` from registry.
- **Fork named session**: Query with `resume: id` + `forkSession: true`.
- **New named session (first use)**: Fresh query (no `resume`), caller registers the returned session ID.

`buildQueryOptions()` consolidates existing logic from `createQuery()`: merging config, injecting blackboard MCP server, setting up the auto-decline elicitation wrapper, converting outputSchema to outputFormat. The `resume` and `forkSession` fields are passed inside `options` (the SDK's `Options` type), not at the top-level query parameter.

`persistSession` is set to `false` by default. Cartographer manages session persistence via `StateStore`, and the query-per-send model would otherwise accumulate session files on disk for every `send()` call.

Signal/abort handling: each query gets the signal from the current send's options directly. No interrupt-wiring through the demux loop.

`close()` aborts the active query (if any) and sets the `_closed` flag to reject future `send()` calls.

### Private Sessions

Agents without a named session config continue to manage their own conversation state via `_privateSessionId`. Private sessions are not managed by the `SessionRegistry` and not reset on terminal status. This preserves backward compatibility for existing trees that don't use named sessions.

### Tree Lifecycle

**BehaviorTree** creates or accepts the `SessionRegistry` and manages its lifecycle:

```typescript
interface BehaviorTreeConfig {
  root: BTreeNode
  // ... existing fields
  sessionRegistry?: SessionRegistry  // optional — for TreeActor to inject a restored registry
}

class BehaviorTree {
  private readonly sessionRegistry: SessionRegistry

  constructor(config: BehaviorTreeConfig) {
    this.sessionRegistry = config.sessionRegistry ?? new SessionRegistry()
    // ... existing constructor logic, including validation
  }

  async tick(): Promise<NodeStatus> {
    const context: TreeContext = {
      blackboard: this.blackboard,
      events: this.events,
      signal: this.signal,
      sessions: this.sessionRegistry,
    }

    const status = await this.root.tick(context)

    if (status !== NodeStatus.RUNNING) {
      this.sessionRegistry.reset()
    }

    return status
  }
}
```

The `sessionRegistry` config option allows `TreeActor` to inject a restored registry when hydrating a tree from persisted state. When omitted, BehaviorTree creates a fresh empty registry.

### TreeActor Serialization

`TreeSessionState` gains a `sessions` field:

```typescript
interface TreeSessionState {
  blackboard: Record<string, unknown>
  treeState: SerializedTreeState
  treeStructure?: { id, name, type, children }
  sessions?: Record<string, string>  // new — name to provider session ID (optional for backward compat)
  createdAt: number
  lastMessageAt: number
  held?: boolean
}
```

The `sessions` field is optional. Existing serialized states without it default to an empty registry (`{}`).

TreeActor's `process()` pipeline:
- **Load**: Restore `SessionRegistry.fromRecord(state.sessions ?? {})` alongside blackboard and node state. Inject the restored registry into the tree via `BehaviorTreeConfig.sessionRegistry`.
- **Save**: Include `sessionRegistry.toRecord()` in the serialized state.
- **Reset**: When the tree reaches terminal status, `tick()` clears the registry, and the saved state reflects this.

Serialized session IDs are references to provider-side state (SDK session storage, ACP agent process). If the provider's storage is wiped between `process()` calls, the session IDs become stale. This is an inherent limitation of external session storage.

### Validation

**Rule**: No two `AgentNode` instances in resume mode on the same session may execute concurrently.

The validation runs in the `BehaviorTree` constructor:

```
validateSessionConcurrency(root):
  Walk the tree. At each ParallelNode:
    For each direct child branch, collect all descendant AgentNodes in resume mode.
    Group by session name.
    If any session name appears in more than one branch, throw an error.
    Recurse into each branch to catch nested ParallelNodes.
```

- Two resume-mode agents on session `"triage"` under a SequenceNode: valid (sequential execution).
- Two resume-mode agents on session `"triage"` under a SelectorNode: valid (only one executes, since SelectorNode ticks children sequentially and stops at the first non-FAILURE result). Note: this safety guarantee depends on the sequential tick-and-stop semantics of SelectorNode. If a future composite allows speculative parallel evaluation of selector children, the validation would need updating.
- Two resume-mode agents on session `"triage"` under different branches of a ParallelNode: error.
- Fork-mode agents are excluded from this check — any number of agents can fork the same session concurrently.

**Not validated statically:**
- Fork of a session that hasn't been created yet — runtime error, because execution order depends on tree dynamics.
- Session name typos — misspellings silently create new sessions. An optional `sessions` declaration on BehaviorTree config could catch this in a follow-up.

## Fork Semantics

Fork is for context inheritance, not conversation merging. When agents fork a session:
- Each fork gets a snapshot of the parent conversation as context.
- Each fork's own work diverges independently.
- The parent session is untouched.
- There is no mechanism to merge forked conversations back into the parent — no provider supports this.

The typical pattern for "classify then parallel analysis then summarize":
- Classify agent resumes `"triage"`.
- Parallel agents create named forks: `{ name: "triage", fork: "billing-thread" }`, `{ name: "triage", fork: "tech-thread" }`.
- Summarize agent gets structured results from blackboard, or resumes a specific named fork if it needs one branch's full conversation context.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Session ownership | Tree-level, named, any node can use | Sessions are shared conversation state, not agent-local |
| Session lifecycle | Reset on terminal status | Bounded by tree runs; RUNNING preserves sessions |
| Fork semantics | Three modes (resume / anonymous fork / named fork) | Explicit intent at configuration level |
| Provider abstraction | Provider-agnostic on Agent interface | Session primitives (create, resume, fork) are converging across Claude SDK and ACP |
| Parallel safety | Static validation at construction time | Prevent concurrent resume of same session; forks are always safe |
| Agent lifecycle | Query-per-send | Simpler, aligns with SDK session API design, enables session sharing |
| Private sessions | Agent-managed, not in registry, not reset | Backward compatibility for agents without named sessions |
