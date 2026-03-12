# Agent Integration

AgentNode integrates Claude via the Agent SDK, bringing AI-powered reasoning into behavior trees. Every AgentNode call is an agentic SDK invocation. SDK options are passed directly via the `options` field, giving you access to the full range of Agent SDK capabilities.

---

## AgentNode Config

```typescript
import type { Options } from "@anthropic-ai/claude-agent-sdk";

interface AgentNodeConfig {
  name: string;
  prompt: string | ((context: TreeContext) => string);
  mapResult?: (output: unknown, context: TreeContext) => NodeStatus;
  blackboardNamespace?: string;
  cache?: boolean;
  options?: Partial<Options>;
}
```

The `options` field accepts any property from the Agent SDK's `Options` type -- `model`, `effort`, `outputFormat`, `allowedTools`, `mcpServers`, `systemPrompt`, `maxTurns`, `maxBudgetUsd`, `permissionMode`, and many more. See the [Agent SDK documentation](https://platform.claude.com/docs/en/agent-sdk/typescript#options) for the full list of available options.

All AgentNode calls share these behaviors:

- Auto-write results to `{name}:output` on the blackboard.
- Auto-attach a blackboard MCP server (read/write/keys tools).
- Emit comprehensive observability events throughout execution (see [Events](guide-blackboard-and-events.md#event-reference)).

---

## Basic Usage

At its simplest, an AgentNode sends a prompt to Claude and writes the result to the blackboard:

```typescript
import { AgentNode } from "cartographer";

const researcher = new AgentNode({
  name: "research-topic",
  prompt: (ctx) => `Research the following topic and write a summary.

Topic: ${ctx.blackboard.get<string>("topic")}`,
  options: {
    model: "claude-sonnet-4-6",
    maxTurns: 10,
    maxBudgetUsd: 0.5,
    systemPrompt: "You are a research assistant. Be thorough but concise.",
    permissionMode: "acceptEdits",
    allowedTools: ["mcp__web__search"],
    mcpServers: {
      web: webSearchServer,
    },
  },
});
```

Details:

- Emits `agent:tool_use` for each tool use block in assistant messages.
- Emits `agent:error` when the SDK returns an error result (max turns, budget, execution error).
- Merges user-provided `mcpServers` with the auto-attached blackboard server.
- Merges user-provided `allowedTools` with `mcp__blackboard__*`.
- Returns `SUCCESS` if the agent result subtype is `'success'`, `FAILURE` otherwise.

---

## Structured Output with `outputFormat`

Use `options.outputFormat` to receive a response validated against a JSON schema. The SDK validates the response and the structured output is available as the first argument to `mapResult` and also stored at `{name}:output`.

If you're using Zod, convert your schema with `z.toJSONSchema()`. Cartographer automatically strips the `$schema` meta-property that `toJSONSchema()` adds, since the SDK does not accept it.

If `mapResult` is not provided, a successful agent call returns `SUCCESS`.

```typescript
import { z } from "zod/v4";
import { AgentNode, NodeStatus } from "cartographer";

const classifier = new AgentNode({
  name: "classify-intent",
  prompt: (ctx) => `Classify the following user message into one of the categories.

Message: ${ctx.blackboard.get<string>("userMessage")}`,
  options: {
    model: "claude-haiku-4-5-20251001",
    effort: "low",
    outputFormat: {
      type: "json_schema",
      schema: z.toJSONSchema(
        z.object({
          category: z.enum(["question", "complaint", "feedback", "other"]),
          confidence: z.number(),
        }),
      ) as any,
    },
  },
  mapResult: (output, ctx) => {
    const result = output as { category: string; confidence: number };
    return result.confidence > 0.8 ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
  },
});
```

All SDK options are available regardless of whether `outputFormat` is set.

---

## Blackboard MCP Server

`createBlackboardMcpServer(blackboard, namespace?)` creates an MCP server that is automatically attached to every AgentNode.

```typescript
import { createBlackboardMcpServer } from "cartographer";
```

The server exposes three tools:

- `blackboard_read` -- Read a value by key.
- `blackboard_write` -- Write a value by key.
- `blackboard_keys` -- List all keys.

When `blackboardNamespace` is configured on the AgentNode, the MCP server uses `blackboard.scoped(namespace)` -- the agent only sees and writes keys within its namespace.

This bridges the gap between deterministic BT nodes and AI-powered reasoning, allowing agents to read context from the blackboard and write results back.

---

## Dynamic Prompts

The `prompt` field accepts either a string or a function `(context: TreeContext) => string`. Use functions to interpolate blackboard state:

```typescript
import { z } from "zod/v4";

const summarizer = new AgentNode({
  name: "summarize",
  prompt: (ctx) => {
    const data = ctx.blackboard.get<string[]>("articles");
    return `Summarize these ${data?.length ?? 0} articles:\n${data?.join("\n")}`;
  },
  options: {
    outputFormat: {
      type: "json_schema",
      schema: z.toJSONSchema(z.object({ summary: z.string() })) as any,
    },
  },
});
```

---

## Elicitation

MCP servers can request user input during agent execution — for example, an OAuth server asking for credentials, or a form server requesting configuration values. The Agent SDK surfaces these as *elicitation requests*. By default, `AgentNode` silently declines all elicitation requests, but you can provide handlers at multiple levels.

### Tree-Level Handler

Set a default handler for all `AgentNode` instances in the tree using `TreeBuilder.onElicitation()` or `BehaviorTreeConfig.onElicitation`:

```typescript
import { TreeBuilder, NodeStatus } from 'cartographer';
import type { OnElicitation } from 'cartographer';

const handler: OnElicitation = async (request, { signal }) => {
  console.log(`Server "${request.serverName}" requests: ${request.message}`);
  // Return user-provided values
  return { action: 'accept', content: { token: 'my-api-key' } };
};

const tree = new TreeBuilder('with-elicitation')
  .onElicitation(handler)
  .sequence('main', (b) => {
    b.agent('worker', { prompt: 'Do work that may require auth' });
  })
  .build();
```

### Per-Subtree Handler

Use context overrides to scope a handler to a specific branch of the tree. The closest handler to an `AgentNode` wins:

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

### Handler Precedence

`AgentNode` resolves the elicitation handler with this priority:

1. `options.onElicitation` (node-level)
2. `context.onElicitation` (inherited through context layering)
3. Auto-decline with `agent:elicitation_declined` event

### Decline Events

When no handler exists at any level, the request is automatically declined and an `agent:elicitation_declined` event is emitted. Use this for logging or alerting:

```typescript
tree.events.on('agent:elicitation_declined', ({ node, request }) => {
  console.warn(
    `Elicitation from "${request.serverName}" declined by "${node.name}": ${request.message}`
  );
});
```

### Elicitation Types

The SDK provides two elicitation modes:

- `form` — The server requests structured input via a JSON schema (`requestedSchema`).
- `url` — The server directs the user to a URL (e.g., an OAuth authorization page).

The handler returns `{ action, content? }` where `action` is one of `'accept'`, `'decline'`, or `'cancel'`.

```typescript
import type { OnElicitation, ElicitationRequest } from 'cartographer';
```

Both types are re-exported from the package for convenience.

---

## Agent Strategies

Agent strategies use Claude to make composite-level decisions. See [guide-composites.md](guide-composites.md) for the strategy pattern overview.

### Config

```typescript
import type { Options } from "@anthropic-ai/claude-agent-sdk";

interface AgentStrategyConfig {
  prompt: string | ((children: BTreeNode[], context: TreeContext) => string);
  childDescriptions?: Record<string, string>;
  cache?: boolean;
  options?: Partial<Options>;
}
```

The `options` field accepts the same [Agent SDK `Options`](https://platform.claude.com/docs/en/agent-sdk/typescript#options) as `AgentNodeConfig`. Agent strategies default to `model: 'sonnet'` and `effort: 'low'` when not specified.

### Implementations

- `AgentSelectionStrategy` -- Reorders selector children. Schema: `{ ordering: string[], reasoning: string }`.
- `AgentExecutionStrategy` -- Reorders sequence children. Schema: `{ ordering: string[], reasoning: string }`.
- `AgentParallelStrategy` -- Adjusts parallel policy. Schema: `{ policy: ParallelPolicy, reasoning: string }`.

All three use `buildStrategyPrompt()`, which constructs a prompt including child names/descriptions and current blackboard state. On agent failure, they fall back to default behavior (original order / all-must-succeed).

Agent strategies emit the full suite of `agent:*` observability events during their SDK calls — `agent:prompt` before calling Claude, intermediate events like `agent:thinking` and `agent:text` as the SDK streams, and `agent:response` or `agent:error` when the result arrives. After a successful call, they also emit `strategy:decision` with the parsed decision payload. This means any observer listening for `agent:*` events (including `createTreeLogger`) automatically captures strategy SDK interactions with no additional setup.

---

## Caching

Both `AgentNode` and the agent strategies accept a `cache: true` option.

**AgentNode caching:** When enabled, the first Claude API call is made normally, but the result is stored and returned directly on subsequent ticks without calling Claude again. The cache is cleared when `reset()` is called. This is useful in multi-tick workflows where the tree is ticked repeatedly by a scheduler with `resetBetweenTicks: false`.

```typescript
// Agent node: call Claude once, return cached status on subsequent ticks
b.agent("classify", {
  prompt: "Classify this ticket",
  options: { model: "claude-haiku-4-5-20251001" },
  cache: true,
});
```

**Agent strategy caching:** Composites (sequence, selector) already guarantee intra-cycle order stability — the strategy is consulted once when an execution cycle starts and the order is committed until the cycle completes (SUCCESS/FAILURE) or the node is reset. The `cache` flag on strategies controls whether the decision persists _across_ execution cycles. Without it, a new cycle re-consults the strategy. With it, the same decision is reused until `reset()`.

```typescript
// Agent strategy: reuse the ordering across execution cycles until reset()
const strategy = new AgentSelectionStrategy({
  prompt: "Pick the best approach",
  options: { model: "claude-haiku-4-5-20251001" },
  cache: true,
});
```

Caches are cleared when the tree resets. With the scheduler, this means:

- `resetBetweenTicks: true` (default) — caches are cleared before each tick, so caching has no effect.
- `resetBetweenTicks: false` — caches persist across ticks, avoiding redundant Claude calls until the tree is explicitly reset.

---

## Cost Management

Control costs with:

- `options.maxBudgetUsd` on AgentNode.
- `options.effort: 'low'` for simple tasks.
- `options.model: 'claude-haiku-4-5-20251001'` for fast, inexpensive operations.
- Track spending via `agent:response` and `agent:error` events (both include a `cost` field).

```typescript
tree.events.on("agent:response", ({ node, cost }) => {
  console.log(`${node.name}: $${cost?.toFixed(4)}`);
});

tree.events.on("agent:error", ({ node, subtype, cost }) => {
  console.log(`${node.name} failed (${subtype}): $${cost?.toFixed(4)}`);
});
```

---

## With vs Without `outputFormat`

| Criterion     | With `outputFormat`                    | Without `outputFormat`                |
| ------------- | -------------------------------------- | ------------------------------------- |
| Output format | JSON schema validated                  | Free text                             |
| `mapResult`   | Available                              | Available                             |
| Tools         | All options available                  | All options available                 |
| Use when      | Classification, extraction, formatting | Research, code gen, complex reasoning |

---

## Worked Example: Classification Pipeline

This example combines structured and unstructured agent calls in a single tree. A cheap structured call classifies a support ticket, then conditional routing decides whether to escalate to a more thorough handler. For a complete, runnable version of this pattern with Zod schemas, billing analysis, and escalation handling, see the [content pipeline example](../examples/README.md#content-pipeline).

```typescript
import { z } from "zod/v4";
import { TreeBuilder, NodeStatus, AgentNode } from "cartographer";

const tree = new TreeBuilder("classification-pipeline")
  .sequence("classify-and-act", (b) => {
    // Step 1: Classify with structured output (fast, cheap)
    b.agent("classify", {
      prompt: (ctx) => `Classify this support ticket: ${ctx.blackboard.get<string>("ticket")}`,
      options: {
        model: "claude-haiku-4-5-20251001",
        effort: "low",
        outputFormat: {
          type: "json_schema",
          schema: z.toJSONSchema(
            z.object({
              category: z.enum(["billing", "technical", "general"]),
              urgency: z.enum(["low", "medium", "high"]),
            }),
          ) as any,
        },
      },
    });

    // Step 2: Route based on classification
    b.selector("route", (b) => {
      b.sequence("urgent-path", (b) => {
        b.condition("is-urgent", (ctx) => {
          const result = ctx.blackboard.get<{ urgency: string }>("classify:output");
          return result?.urgency === "high";
        });
        // Step 3: Handle urgent tickets thoroughly
        b.agent("handle-urgent", {
          prompt: (ctx) => {
            const ticket = ctx.blackboard.get<string>("ticket");
            const classification = ctx.blackboard.get("classify:output");
            return `Draft an urgent response for this ${JSON.stringify(classification)} ticket: ${ticket}`;
          },
          options: {
            model: "claude-sonnet-4-6",
            maxTurns: 5,
            maxBudgetUsd: 0.25,
          },
        });
      });
      b.action("handle-normal", async (ctx) => {
        console.log("Queued for standard processing");
        return NodeStatus.SUCCESS;
      });
    });
  })
  .build();
```

---

## Where to go next

- [Leaf Nodes](guide-nodes.md) -- ActionNode, ConditionNode, and custom nodes.
- [Composites and Strategies](guide-composites.md) -- Selector, sequence, parallel, and the strategy pattern.
- [Decorator Nodes](guide-decorators.md) -- Inverter, retry, guard, timeout, and more.
- [Building Trees](guide-building-trees.md) -- TreeBuilder, nesting, and construction patterns.
- [Examples](../examples/README.md) -- complete runnable programs demonstrating agent nodes in realistic scenarios.
