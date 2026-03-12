# Elicitation

MCP servers can request user input during agent execution — for example, an OAuth server asking for credentials, or a form server requesting configuration values. The Agent SDK surfaces these as *elicitation requests*. By default, `AgentNode` silently declines all elicitation requests, but you can provide handlers at three levels with clear precedence rules.

---

## What Is Elicitation?

When an `AgentNode` invokes Claude via the Agent SDK, the MCP servers attached to that agent may need information from the user. The SDK models this as an *elicitation request*: the server sends a message describing what it needs, and the handler responds with a result.

```typescript
import type { OnElicitation, ElicitationRequest } from 'cartographer';
```

Both types are re-exported from `@anthropic-ai/claude-agent-sdk` for convenience.

An `ElicitationRequest` contains:

| Field             | Description                                                       |
| ----------------- | ----------------------------------------------------------------- |
| `serverName`      | Name of the MCP server requesting input.                          |
| `message`         | Human-readable description of what the server needs.              |
| `mode`            | Either `'form'` (structured input via JSON schema) or `'url'` (directs user to a URL, e.g. OAuth). |
| `requestedSchema` | When `mode` is `'form'`, the JSON schema describing expected input fields. |

A handler returns `{ action, content? }` where `action` is one of:

- `'accept'` — Provide the requested values in `content`.
- `'decline'` — Refuse the request (the MCP server must handle the refusal).
- `'cancel'` — Cancel the entire operation.

---

## Handler Levels

Cartographer supports three levels of elicitation handlers, from broadest to most specific.

### Tree-Level Handler

Set a default handler for all `AgentNode` instances in the tree using `TreeBuilder.onElicitation()` or `BehaviorTreeConfig.onElicitation`:

```typescript
import { TreeBuilder } from 'cartographer';
import type { OnElicitation } from 'cartographer';

const handler: OnElicitation = async (request, { signal }) => {
  console.log(`Server "${request.serverName}" requests: ${request.message}`);
  return { action: 'accept', content: { token: 'my-api-key' } };
};

const tree = new TreeBuilder('with-elicitation')
  .onElicitation(handler)
  .sequence('main', (b) => {
    b.agent('worker', { prompt: 'Do work that may require auth' });
  })
  .build();
```

The tree-level handler is wired to the root node's context overrides internally. Every `AgentNode` in the tree inherits it through context propagation.

### Per-Subtree Handler

Use context overrides to scope a handler to a specific branch of the tree. See [Context Layering](guide-context.md) for how this mechanism works.

```typescript
const tree = new TreeBuilder('scoped-elicitation')
  .onElicitation(defaultHandler) // tree-level fallback
  .sequence('main', (b) => {
    // This subtree uses a different handler
    b.sequence('oauth-branch', { context: { onElicitation: oauthHandler } }, (b) => {
      b.agent('oauth-agent', { prompt: 'Connect to OAuth service' });
    });

    // This agent inherits the tree-level handler
    b.agent('other-agent', { prompt: 'Other work' });
  })
  .build();
```

The closest handler to an `AgentNode` wins. In the example above, `oauth-agent` sees `oauthHandler` while `other-agent` sees `defaultHandler`.

### Node-Level Handler

For maximum specificity, set `onElicitation` directly in the agent's `options`:

```typescript
b.agent('specific-agent', {
  prompt: 'Work requiring credentials',
  options: {
    onElicitation: async (request) => {
      return { action: 'accept', content: { apiKey: process.env.API_KEY } };
    },
  },
});
```

---

## Handler Precedence

`AgentNode` resolves the elicitation handler with this priority:

1. **`options.onElicitation`** (node-level) — highest priority
2. **`context.onElicitation`** (inherited through context layering) — middle priority
3. **Auto-decline** with `agent:elicitation_declined` event — fallback

The resolution logic in `AgentNode`:

```typescript
const userElicitationHandler = options.onElicitation ?? context.onElicitation;

if (userElicitationHandler) {
  return userElicitationHandler(request, opts);
}
// No handler — decline and emit event
context.events.emit('agent:elicitation_declined', { node, request });
return { action: 'decline' };
```

---

## Decline Events

When no handler exists at any level, the request is automatically declined and an `agent:elicitation_declined` event is emitted. Use this for logging or alerting:

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
| `node`    | `BTreeNode`          | The AgentNode that declined.    |
| `request` | `ElicitationRequest` | The original elicitation request. |

---

## Elicitation Request Types

The SDK provides two elicitation modes:

### Form Mode

The server requests structured input via a JSON schema. The `requestedSchema` field describes the expected fields:

```typescript
const formHandler: OnElicitation = async (request) => {
  if (request.mode === 'form') {
    // Inspect request.requestedSchema for field definitions
    return {
      action: 'accept',
      content: { username: 'admin', password: process.env.DB_PASS },
    };
  }
  return { action: 'decline' };
};
```

### URL Mode

The server directs the user to a URL (e.g., an OAuth authorization page):

```typescript
const urlHandler: OnElicitation = async (request) => {
  if (request.mode === 'url') {
    // request.message contains the URL or instructions
    console.log(`Please visit: ${request.message}`);
    // After user completes the flow, accept with any tokens received
    return { action: 'accept', content: { authCode: '...' } };
  }
  return { action: 'decline' };
};
```

---

## Re-Exported Types

Both `OnElicitation` and `ElicitationRequest` are re-exported from the `cartographer` package:

```typescript
import type { OnElicitation, ElicitationRequest } from 'cartographer';
```

These originate from `@anthropic-ai/claude-agent-sdk`. You do not need to depend on the SDK package directly to use them.

---

## Where to Go Next

- [TreeContext and Context Layering](guide-context.md) — How context overrides propagate through the tree.
- [Agent Integration](guide-agent-integration.md) — AgentNode configuration, strategies, and MCP tools.
- [Blackboard and Events](guide-blackboard-and-events.md) — Event reference including `agent:elicitation_declined`.
