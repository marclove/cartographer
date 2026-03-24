# ClaudeSDKAgent Decomposition Design

## Problem

`ClaudeSDKAgent` is a god class — message mapping, session management, option building, MCP/blackboard injection, and elicitation wiring are tangled together in one 434-line file (~250 lines of logic). The tangling is concentrated in `buildQueryOptions()`, which mixes five distinct concerns in 65 lines. This makes individual concerns hard to test in isolation and provides no structural pattern for the next `Agent` implementation (ACP).

## Goals

- Decompose `ClaudeSDKAgent` into a thin orchestrator backed by focused, testable pure functions.
- Establish a clear file-level pattern (`<provider>-agent.ts`, `<provider>-mapper.ts`, `<provider>-options.ts`) that future provider adapters follow.
- No behavioral changes — public API, emitted messages, and the `Agent` interface contract stay identical.

## Non-goals

- Shared base class or abstract adapter — the reusable surface is too small (~20 lines of lifecycle/session tracking) to justify inheritance before a second provider exists.
- Changes to `AgentNode` — it consumes only the `Agent` interface, which is unchanged.
- Changes to the public export surface — extracted functions stay internal.

## Constraints

- `Agent` interface is the stable contract. All refactoring happens behind it.
- ACP is the planned next provider. The decomposition should make it obvious how to write `acp-agent.ts` + `acp-mapper.ts` + `acp-options.ts` by following the Claude SDK pattern.
- Existing `claude-sdk-agent.test.ts` must continue passing unchanged.

## Design

### File structure

```
agent/
  agent.ts                  # Agent interface + types (unchanged)
  claude-sdk-agent.ts       # Thin orchestrator (~120-150 lines)
  claude-sdk-mapper.ts      # NEW: pure SDK→framework message mapping
  claude-sdk-options.ts     # NEW: option-building helpers
  blackboard-mcp.ts         # Blackboard MCP server (unchanged)
  sdk-helpers.ts            # wrapElicitation, buildStrategyPrompt (unchanged)
  test-agent.ts             # Test double (unchanged)
```

### `claude-sdk-mapper.ts`

A single pure function extracted verbatim from `ClaudeSDKAgent.mapSdkMessage`:

```typescript
export function mapSdkMessage(msg: SDKMessage): AgentMessage[]
```

Handles the switch over `msg.type`: `assistant` (one message per content block — thinking, text, tool_use), `result` (success with structured_output/JSON parse fallback, error), `system` (init/status), `stream_event`, `tool_progress`, `rate_limit_event`, and unknown-type pass-through.

Zero state, zero dependencies beyond SDK types and `AgentMessage`.

### `claude-sdk-options.ts`

Decomposition of `buildQueryOptions` into four focused functions:

**`injectBlackboardMcp`** — Adds the blackboard MCP server and `mcp__blackboard__*` tool pattern to copies of the MCP servers map and allowed tools array.

```typescript
export function injectBlackboardMcp(
  mcpServers: Record<string, unknown>,
  allowedTools: string[],
  blackboard: Blackboard,
  namespace?: string,
): { mcpServers: Record<string, unknown>; allowedTools: string[] }
```

**`buildSdkElicitationHandler`** — Wraps the optional framework `OnElicitation` handler into an `SDKOnElicitation` that always responds (never hangs). Constructs `AgentElicitationRequest` from SDK request fields. Maps framework `cancel` → SDK `decline`.

```typescript
export function buildSdkElicitationHandler(
  handler?: OnElicitation,
): SDKOnElicitation
```

**`buildSdkOutputFormat`** — Resolves the output format from per-call `outputSchema` or config `outputFormat`, stripping `$schema` in both paths.

```typescript
export function buildSdkOutputFormat(
  configFormat?: unknown,
  sendOptionsSchema?: Record<string, unknown>,
): unknown | undefined
```

**`composeSdkOptions`** — Thin orchestrator that calls the three above, spreads remaining config options, sets the `permissionMode` default, and forwards the abort signal. This is what `ClaudeSDKAgent` calls instead of the monolithic `buildQueryOptions`.

```typescript
export function composeSdkOptions(
  config: ClaudeSDKAgentConfig,
  sendOptions?: AgentSendOptions,
): Record<string, unknown>
```

### Slimmed-down `ClaudeSDKAgent`

After extraction, the class retains only orchestration concerns:

- **Constructor** — reserved "blackboard" MCP name validation, stores config.
- **State** — `_lastSessionId`, `_privateSessionId`, `_activeQuery`, `_closed` (unchanged).
- **`send()`** — closed check, returns async iterable wrapping `_createSendIterator`.
- **`_createSendIterator()`** — session resolution (private vs. explicit), calls `composeSdkOptions()` (imported), creates SDK `query()`, iterates messages through `mapSdkMessage()` (imported), handles `session_start` init detection, dispatches via `_dispatchMapped`.
- **`_dispatchMapped()`** — stays in-class (uses `yield*`, must be a generator method).
- **`getInfo()`** — unchanged.
- **`close()`** — unchanged.

Drops from ~250 lines of logic to ~100. The class's only job is orchestration: session state, query lifecycle, and wiring the pure functions together.

### Exports

Extracted functions are **internal only**. The public API surface exported from `index.ts` is unchanged: `ClaudeSDKAgent`, `ClaudeSDKAgentConfig`, and the `Agent` interface types.

## Testing strategy

**Existing tests** — `claude-sdk-agent.test.ts` continues passing unchanged. These are integration-level tests through the public `send()` API.

**New unit tests:**

- **`claude-sdk-mapper.test.ts`** — SDK message fixtures → `mapSdkMessage` → assert `AgentMessage[]`. Covers each branch: assistant (thinking/text/tool_use blocks), result (success with structured_output, success with JSON string, success with plain string, error), system (init/status), stream_event, tool_progress, rate_limit_event, and unknown-type pass-through.

- **`claude-sdk-options.test.ts`** — Unit tests for each helper:
  - `injectBlackboardMcp`: server injection, tool pattern added, namespace forwarding.
  - `buildSdkElicitationHandler`: with handler (accept/decline/cancel→decline mapping), without handler (auto-decline).
  - `buildSdkOutputFormat`: sendOptions schema wins, config format `$schema` stripped, passthrough when neither.
  - `composeSdkOptions`: verifies composition and `permissionMode` default.

## Future provider pattern

When ACP is implemented, follow the same structure:

```
agent/
  acp-agent.ts              # ACP orchestrator
  acp-mapper.ts             # ACP message → AgentMessage mapping
  acp-options.ts            # ACP option-building helpers
```

If shared patterns emerge between the two implementations (e.g., session tracking utilities), extract them at that point with concrete evidence rather than speculating now.
