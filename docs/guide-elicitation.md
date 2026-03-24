# Elicitation

MCP servers can request user input during agent execution — for example, an OAuth server asking for credentials, or a form server requesting configuration values. The Agent SDK surfaces these as *elicitation requests*. By default, all agent calls — both `AgentNode` executions and agent strategy decisions — silently decline elicitation requests, but you can provide handlers at two levels with clear precedence rules.

---

## What Is Elicitation?

When Claude is invoked via the Agent SDK — whether through an `AgentNode` or an agent strategy (`AgentSelectionStrategy`, `AgentExecutionStrategy`, `AgentParallelStrategy`) — the MCP servers attached to that call may need information from the user. The SDK models this as an *elicitation request*: the server sends a message describing what it needs, and the handler responds with a result.

```typescript
import type { OnElicitation, AgentElicitationRequest } from 'cartographer';
```

These are framework-owned types — you do not need to depend on `@anthropic-ai/claude-agent-sdk` directly.

An `AgentElicitationRequest` contains:

| Field              | Type                       | Description                                                       |
| ------------------ | -------------------------- | ----------------------------------------------------------------- |
| `message`          | `string`                   | Human-readable description of what the server needs.              |
| `schema`           | `Record<string, unknown>`  | Optional. JSON schema describing expected input fields (only for `'form'` mode). |
| `serverName`       | `string`                   | Optional. Name of the MCP server requesting input.                |
| `mode`             | `string`                   | Optional. `'form'` for structured input, `'url'` for browser-based auth (e.g. OAuth). |
| `url`              | `string`                   | Optional. URL to open (only for `'url'` mode).                    |
| `elicitationId`    | `string`                   | Optional. Correlation ID for URL elicitations.                    |

A handler returns an `AgentElicitationResponse` where `action` is one of:

- `'accept'` — Provide the requested values in `data`.
- `'decline'` — Refuse the request (the MCP server must handle the refusal).
- `'cancel'` — Cancel the entire operation (mapped to `'decline'` at the provider level).

> **Note:** The `action` field here is part of the elicitation protocol and refers to the *response disposition* (accept, decline, or cancel). It is unrelated to Cartographer's action nodes.

---

## Handler Levels

Cartographer supports two levels of elicitation handlers. These apply uniformly to both `AgentNode` executions and agent strategy calls.

### Tree-Level Handler

Set a default handler for all `AgentNode` instances and agent strategies in the tree using `TreeBuilder.onElicitation()` or `BehaviorTreeConfig.onElicitation`:

```typescript
import { TreeBuilder, ClaudeSDKAgent } from 'cartographer';
import type { OnElicitation } from 'cartographer';

const workerAgent = new ClaudeSDKAgent({ name: 'worker', model: 'claude-sonnet-4-6' });

const handler: OnElicitation = async (request) => {
  // Only respond to requests from the expected MCP server
  if (request.serverName === 'auth-server' && request.mode === 'form') {
    return { action: 'accept', data: { token: 'my-api-key' } };
  }
  return { action: 'decline' };
};

const tree = new TreeBuilder('with-elicitation')
  .onElicitation(handler)
  .sequence('main', (b) => {
    b.agent('worker', { agent: workerAgent, prompt: 'Do work that may require auth' });
  })
  .build();
```

The tree-level handler is wired to the root node's context overrides internally. Every `AgentNode` and agent strategy in the tree inherits it through context propagation.

### Per-Subtree Handler

Use context overrides to scope a handler to a specific branch of the tree. See [Context Layering](guide-context.md) for how this mechanism works.

```typescript
const tree = new TreeBuilder('scoped-elicitation')
  .onElicitation(defaultHandler) // tree-level fallback
  .sequence('main', (b) => {
    // This subtree uses a different handler
    b.sequence('oauth-branch', { context: { onElicitation: oauthHandler } }, (b) => {
      b.agent('oauth-agent', { agent: oauthAgent, prompt: 'Connect to OAuth service' });
    });

    // This agent inherits the tree-level handler
    b.agent('other-agent', { agent: generalAgent, prompt: 'Other work' });
  })
  .build();
```

The closest handler to an `AgentNode` wins. In the example above, `oauth-agent` sees `oauthHandler` while `other-agent` sees `defaultHandler`.

---

## Handler Precedence

Both `AgentNode` and agent strategies resolve the elicitation handler the same way:

1. **`context.onElicitation`** (inherited through context layering) — highest priority
2. **Auto-decline** with `agent:elicitation_declined` event — fallback

`AgentNode` passes `context.onElicitation` (wrapped via `wrapElicitation`) to the agent's `send()` method. Agent strategies do the same. If no handler exists at any level, the request is auto-declined and an `agent:elicitation_declined` event is emitted.

The resolution logic is shared via the `wrapElicitation` helper:

```typescript
import { wrapElicitation } from 'cartographer';

// The handler is resolved from context:
const wrapped = wrapElicitation(context.onElicitation, node, context.events);

// `wrapped` always returns a response — delegates to the handler if
// present, otherwise emits agent:elicitation_declined and declines.
```

---

## Decline Events

When no handler exists at any level, the request is automatically declined and an `agent:elicitation_declined` event is emitted. This applies to both `AgentNode` calls and agent strategy calls. Use this for logging or alerting:

```typescript
tree.events.on('agent:elicitation_declined', ({ node, request }) => {
  console.warn(
    `Elicitation from "${request.serverName}" declined by "${node.name}": ${request.message}`
  );
});
```

The event payload contains:

| Field     | Type                 | Description                     |
| --------- | -------------------- | ------------------------------- |
| `node`    | `BTreeNode`          | The node that declined. For `AgentNode`, this is the agent itself. For strategies, this is `children[0]` (the proxy node). |
| `request` | `AgentElicitationRequest` | The original elicitation request. |

---

## Elicitation in Agent Strategies

Agent strategies (`AgentSelectionStrategy`, `AgentExecutionStrategy`, `AgentParallelStrategy`) make their own agent calls via the configured `Agent` instance. These calls handle elicitation using the same resolution logic as `AgentNode`.

Strategies pass `context.onElicitation` to `agent.send()`. Since strategies receive the `TreeContext` from their parent composite, a tree-level or subtree-level handler is automatically inherited:

```typescript
import { TreeBuilder, AgentSelectionStrategy, ClaudeSDKAgent } from 'cartographer';

const strategyAgent = new ClaudeSDKAgent({ name: 'strategy', model: 'claude-haiku-4-5', effort: 'low' });
const workerAgent = new ClaudeSDKAgent({ name: 'worker', model: 'claude-sonnet-4-6' });

const tree = new TreeBuilder('with-strategy-elicitation')
  .onElicitation(async (request) => {
    // This handler is called for both the strategy's agent call
    // and the AgentNode's agent call — only accept known servers
    if (request.serverName === 'auth-server' && request.mode === 'form') {
      return { action: 'accept', data: { token: process.env.API_KEY } };
    }
    return { action: 'decline' };
  })
  .selector('pick', { strategy: new AgentSelectionStrategy({ prompt: 'Pick best', agent: strategyAgent }) }, (b) => {
    b.agent('worker-a', { agent: workerAgent, prompt: 'Plan A' });
    b.agent('worker-b', { agent: workerAgent, prompt: 'Plan B' });
  })
  .build();
```

---

## Elicitation Request Types

The SDK provides two elicitation modes:

### Form Mode

The server requests structured input via a JSON schema. The `requestedSchema` field describes the expected fields:

```typescript
const formHandler: OnElicitation = async (request) => {
  if (request.serverName === 'db-server' && request.mode === 'form') {
    return {
      action: 'accept',
      data: { username: 'admin', password: process.env.DB_PASS },
    };
  }
  return { action: 'decline' };
};
```

### URL Mode

The server directs the user to a URL (e.g., an OAuth authorization page):

```typescript
const urlHandler: OnElicitation = async (request) => {
  if (request.serverName === 'oauth-server' && request.mode === 'url') {
    // request.message contains the URL or instructions
    console.log(`Please visit: ${request.message}`);
    // After user completes the flow, accept with any tokens received
    return { action: 'accept', data: { authCode: '...' } };
  }
  return { action: 'decline' };
};
```

---

## Elicitation Types

The elicitation types are framework-owned and exported from the `cartographer` package:

```typescript
import type { OnElicitation, AgentElicitationRequest, AgentElicitationResponse, ElicitationOptions } from 'cartographer';
```

You do not need to depend on `@anthropic-ai/claude-agent-sdk` directly. Each concrete agent adapter (such as `ClaudeSDKAgent`) maps between these framework types and the provider's elicitation API internally.

---

## Where to Go Next

- [TreeContext and Context Layering](guide-context.md) — How context overrides propagate through the tree.
- [Agent Integration](guide-agent-integration.md) — AgentNode configuration, strategies, and MCP tools.
- [Blackboard and Events](guide-blackboard-and-events.md) — Event reference including `agent:elicitation_declined`.
