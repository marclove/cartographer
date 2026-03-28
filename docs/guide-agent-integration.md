# Agent Integration

Cartographer integrates AI agents into behavior trees through a two-layer architecture: **Agents** define how to talk to an AI provider, and **AgentNodes** wire those agents into the tree's tick lifecycle. This separation means you configure provider details (model, tools, output format) once on an Agent and reuse it across multiple nodes and strategies.

---

## Agents

An `Agent` is a configured AI agent that processes prompts and streams responses. The `Agent` interface defines the provider-agnostic contract; `ClaudeSDKAgent` is the concrete implementation for Claude.

### Defining an Agent

```typescript
import { ClaudeSDKAgent } from "cartographer";

const classifier = new ClaudeSDKAgent({
  name: "classify",
  model: "claude-haiku-4-5",
  effort: "low",
});
```

`ClaudeSDKAgentConfig` is a flat intersection of `AgentConfig` (just `name`) and the SDK's `Partial<Options>`. All SDK options — `model`, `effort`, `outputFormat`, `allowedTools`, `mcpServers`, `systemPrompt`, `maxTurns`, `maxBudgetUsd`, `permissionMode`, and more — sit at the top level. See the [Agent SDK documentation](https://platform.claude.com/docs/en/agent-sdk/typescript#options) for the full list.

### Reusing Agents

A single Agent instance can be shared across multiple AgentNodes and strategies. Without a `session` config, each node gets its own private conversation — the agent manages an internal session that accumulates turns across `send()` calls:

```typescript
const haiku = new ClaudeSDKAgent({
  name: "haiku-agent",
  model: "claude-haiku-4-5",
});

// Same agent, independent private conversations per node
b.agent("classify", { agent: haiku, prompt: classifyPrompt });
b.agent("summarize", { agent: haiku, prompt: summarizePrompt });
```

To share a conversation across multiple nodes, use [named sessions](#sessions).

For agent definitions in larger projects, extract them into a dedicated module (see the [content pipeline example](../apps/content-pipeline/agents.ts) for this pattern).

---

## AgentNode Config

```typescript
interface AgentNodeConfig<TOutput> {
  name: string;
  agent: Agent;
  prompt: string | ((context: TreeContext) => string);
  mapResult?: (output: TOutput, context: TreeContext) => NodeStatus;
  blackboardNamespace?: string;
  cache?: boolean;
  session?: string | SessionConfig;
}
```

The `agent` field is the Agent instance that handles all provider-specific concerns. The node focuses on BT integration: prompt resolution, blackboard I/O, event emission, `mapResult`, and caching.

All AgentNode calls share these behaviors:

- Auto-write results to `{name}:output` on the blackboard.
- Auto-attach a blackboard MCP server (read/write/keys tools).
- Emit comprehensive observability events throughout execution (see [Events](guide-blackboard-and-events.md#event-reference)).

---

## Basic Usage

At its simplest, an `AgentNode` sends a prompt to an `Agent` and writes the result to the blackboard:

```typescript
import { AgentNode, ClaudeSDKAgent } from "cartographer";

const researchAgent = new ClaudeSDKAgent({
  name: "research",
  model: "claude-sonnet-4-6",
  maxTurns: 10,
  maxBudgetUsd: 0.5,
  systemPrompt: "You are a research assistant. Be thorough but concise.",
  permissionMode: "acceptEdits",
  allowedTools: ["mcp__web__search"],
  mcpServers: {
    web: webSearchServer,
  },
});

const researcher = new AgentNode<unknown>({
  name: "research-topic",
  agent: researchAgent,
  prompt: (ctx) => `Research the following topic and write a summary.

Topic: ${ctx.blackboard.get<string>("topic")}`,
});
```

Details:

- Emits `agent:tool_use` for each tool use block in assistant messages.
- Emits `agent:error` when the SDK returns an error result (max turns, budget, execution error).
- The agent merges user-provided `mcpServers` with the auto-attached blackboard server.
- The agent merges user-provided `allowedTools` with `mcp__blackboard__*`.
- Returns `SUCCESS` if the agent result subtype is `'success'`, `FAILURE` otherwise.

---

## Structured Output with `outputFormat`

Configure `outputFormat` on the agent to receive a response validated against a JSON schema. The SDK validates the response and the structured output is available as the first argument to `mapResult` and also stored at `{name}:output`.

If you're using Zod, convert your schema with `z.toJSONSchema()`.

If `mapResult` is not provided, a successful agent call returns `SUCCESS`.

```typescript
import { z } from "zod/v4";
import { AgentNode, ClaudeSDKAgent, NodeStatus } from "cartographer";

const classifyAgent = new ClaudeSDKAgent({
  name: "classify-intent",
  model: "claude-haiku-4-5",
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
});

const classifier = new AgentNode<{ category: string; confidence: number }>({
  name: "classify-intent",
  agent: classifyAgent,
  prompt: (ctx) => `Classify the following user message into one of the categories.

Message: ${ctx.blackboard.get<string>("userMessage")}`,
  mapResult: (output, ctx) => {
    // output is typed as { category: string; confidence: number } — no cast needed
    return output.confidence > 0.8 ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
  },
});
```

---

## Blackboard MCP Server

`createBlackboardMcpServer(blackboard, namespace?)` creates an MCP server that the agent automatically attaches when a blackboard is provided via send options (which AgentNode always does).

```typescript
import { createBlackboardMcpServer } from "cartographer";
```

The server exposes seven tools (named to match Redis conventions):

- `get` -- Get a value by key.
- `set` -- Set a value by key.
- `keys` -- List all keys.
- `delete` -- Delete a key.
- `mget` -- Get multiple values by key.
- `mset` -- Set multiple key-value pairs.
- `mdelete` -- Delete multiple keys.

When `blackboardNamespace` is configured on the AgentNode, the MCP server uses `blackboard.scoped(namespace)` -- the agent only sees and writes keys within its namespace.

This bridges the gap between deterministic conditions and actions and AI-powered reasoning, allowing agents to read context from the blackboard and write results back.

---

## Dynamic Prompts

The `prompt` field accepts either a string or a function `(context: TreeContext) => string`. Use functions to interpolate blackboard state:

```typescript
import { z } from "zod/v4";
import { ClaudeSDKAgent } from "cartographer";

const summarizeAgent = new ClaudeSDKAgent({
  name: "summarize",
  outputFormat: {
    type: "json_schema",
    schema: z.toJSONSchema(z.object({ summary: z.string() })) as any,
  },
});

// In the builder:
b.agent("summarize", {
  agent: summarizeAgent,
  prompt: (ctx) => {
    const data = ctx.blackboard.get<string[]>("articles");
    return `Summarize these ${data?.length ?? 0} articles:\n${data?.join("\n")}`;
  },
});
```

---

## Elicitation

MCP servers can request user input during agent execution. By default, `ClaudeSDKAgent` silently declines all elicitation requests, but you can provide handlers at the tree or subtree level.

See the dedicated [Elicitation guide](guide-elicitation.md) for handler examples, precedence rules, decline events, and request types.

---

## Sessions

By default, each AgentNode maintains its own private conversation with its agent. Named sessions let multiple AgentNodes participate in the same conversation — one node starts the conversation, and later nodes resume it with full history. This is useful when a multi-step workflow needs continuity: a triage agent classifies a ticket, then a handler agent picks up the same conversation to act on it.

### Configuring Sessions

Add a `session` field to `AgentNodeConfig`. The shorthand string form and the full object form are equivalent:

```typescript
// Shorthand — resume mode
b.agent("triage", { agent, prompt: triagePrompt, session: "support" });

// Equivalent full form
b.agent("triage", {
  agent,
  prompt: triagePrompt,
  session: { name: "support" },
});
```

### Session Modes

There are two modes for participating in a named session:

**Resume mode** (default) — the agent appends to the session's conversation. If the session does not exist yet, a new one is created and registered. If it already exists, the agent resumes it with full history.

```typescript
// First agent creates the "support" session
b.agent("triage", { agent: triageAgent, prompt: triagePrompt, session: "support" });

// Second agent resumes the same conversation
b.agent("respond", { agent: responder, prompt: respondPrompt, session: "support" });
```

**Fork mode** — the agent branches from an existing session, creating an independent copy of the conversation. The original session is unaffected. Fork mode requires the parent session to already exist (a resume-mode agent must run first).

```typescript
// Anonymous fork — ephemeral, not registered in the session registry
b.agent("analyst", {
  agent: analystAgent,
  prompt: analysisPrompt,
  session: { name: "support", fork: true },
});

// Named fork — registered under the fork name for downstream resumption
b.agent("analyst", {
  agent: analystAgent,
  prompt: analysisPrompt,
  session: { name: "support", fork: "analysis" },
});
```

An anonymous fork (`fork: true`) is useful for one-off branches that no other node needs to resume. A named fork (`fork: "analysis"`) registers the forked session under the given name, so other agents can resume from the fork point.

### SessionConfig

```typescript
interface SessionConfig {
  name: string;
  fork?: true | string;
}
```

| Field  | Type             | Description                                                                                                                                                    |
| ------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name` | `string`         | The named session to participate in.                                                                                                                           |
| `fork` | `true \| string` | Optional. `true` creates an anonymous fork. A string creates a named fork registered under that name. When absent, the agent resumes (appends to) the session. |

### Session Lifecycle

The tree's `SessionRegistry` maps session names to provider session IDs. It is managed automatically:

- **Created or restored** when the tree starts ticking (or when `MessageProcessor` hydrates state).
- **Preserved** across ticks that return `RUNNING` and across `interrupt()` calls — agents can resume their conversations on the next tick.
- **Cleared** when the tree reaches a terminal status (`SUCCESS` or `FAILURE`), or when `abort()` or `reset()` is called.

This means sessions live for the duration of a single tree run. If you need sessions to survive across independent runs, use `ActorServer` with a `StateStore` — it serializes and restores the session registry alongside the blackboard and tree state.

### Session Concurrency Validation

Resume-mode agents on the same named session must not execute concurrently — interleaved messages would produce unpredictable conversation state. Cartographer enforces this at construction time: if two AgentNodes configured to resume the same session appear in different branches of a `ParallelNode`, the `BehaviorTree` constructor throws.

Fork-mode agents are exempt from this check because each fork creates an independent conversation branch.

```typescript
// This throws at construction time:
b.parallel("bad", (b) => {
  b.agent("a", { agent, prompt: "...", session: "shared" }); // resume
  b.agent("b", { agent, prompt: "...", session: "shared" }); // resume — conflict!
});

// This is fine — forks are independent:
b.parallel("ok", (b) => {
  b.agent("a", { agent, prompt: "...", session: { name: "shared", fork: true } });
  b.agent("b", { agent, prompt: "...", session: { name: "shared", fork: true } });
});
```

### Worked Example: Triage and Fork

```typescript
import { TreeBuilder, ClaudeSDKAgent } from "cartographer";

const triageAgent = new ClaudeSDKAgent({
  name: "triage",
  model: "claude-haiku-4-5",
  effort: "low",
});

const handlerAgent = new ClaudeSDKAgent({
  name: "handler",
  model: "claude-sonnet-4-6",
  maxTurns: 10,
});

const tree = new TreeBuilder("support-pipeline")
  .sequence("handle-ticket", (b) => {
    // Step 1: Triage creates the "support" session
    b.agent("triage", {
      agent: triageAgent,
      prompt: (ctx) => `Classify this support ticket: ${ctx.blackboard.get("ticket")}`,
      session: "support",
    });

    // Step 2: Handler forks the conversation to draft a response
    // without polluting the triage history
    b.agent("draft-response", {
      agent: handlerAgent,
      prompt: "Based on the triage above, draft a customer response.",
      session: { name: "support", fork: true },
    });
  })
  .build();
```

The triage agent creates the "support" session and classifies the ticket. The handler agent forks from that session — it sees the full triage conversation but its response drafting does not modify the original session.

---

## Agent Strategies

Agent strategies use Claude to make composite-level decisions. See [guide-composites.md](guide-composites.md) for the strategy pattern overview.

### Config

```typescript
interface AgentStrategyConfig {
  prompt: string | ((children: BTreeNode[], context: TreeContext) => string);
  childDescriptions?: Record<string, string>;
  cache?: boolean;
  agent: Agent;
}
```

The `agent` field is the Agent instance used for strategy decisions. Configure model, effort, and other SDK options on the agent:

```typescript
const strategyAgent = new ClaudeSDKAgent({
  name: "strategy",
  model: "claude-haiku-4-5",
  effort: "low",
});

const strategy = new AgentSelectionStrategy({
  prompt: "Pick the best approach",
  agent: strategyAgent,
});
```

### Implementations

- `AgentSelectionStrategy` -- Reorders selector children. Schema: `{ ordering: string[], reasoning: string }`.
- `AgentExecutionStrategy` -- Reorders sequence children. Schema: `{ ordering: string[], reasoning: string }`.
- `AgentParallelStrategy` -- Adjusts parallel policy. Schema: `{ policy: ParallelPolicy, reasoning: string }`.

All three use `buildStrategyPrompt()`, which constructs a prompt including child names/descriptions and current blackboard state. On agent failure, they fall back to default behavior (original order / all-must-succeed).

Agent strategies emit the full suite of `agent:*` observability events during their agent calls — `agent:prompt` before calling the agent, intermediate events like `agent:thinking` and `agent:text` as the agent streams, and `agent:response` or `agent:error` when the result arrives. After a successful call, they also emit `strategy:decision` with the parsed decision payload. This means any observer listening for `agent:*` events (including `createTreeLogger`) automatically captures strategy interactions with no additional setup.

Agent strategies also handle elicitation consistently with `AgentNode`. They pass `context.onElicitation` to the agent's `send()` method, inheriting whatever handler was set via `TreeBuilder.onElicitation()` or context overrides. When no handler is available, elicitation requests are declined and an `agent:elicitation_declined` event is emitted. See the [Elicitation guide](guide-elicitation.md) for details.

---

## Caching

Both `AgentNode` and the agent strategies accept a `cache: true` option.

**AgentNode caching:** When enabled, the first agent call is made normally, but the result is stored and returned directly on subsequent ticks without calling the agent again. The cache is cleared when `reset()` is called. This is useful in multi-tick workflows where the tree is ticked repeatedly by a scheduler.

```typescript
// Agent node: call the agent once, return cached status on subsequent ticks
b.agent("classify", {
  agent: classifyAgent,
  prompt: "Classify this ticket",
  cache: true,
});
```

**Agent strategy caching:** Composites (sequence, selector) already guarantee intra-cycle order stability — the strategy is consulted once when an execution cycle starts and the order is committed until the cycle completes (SUCCESS/FAILURE) or the node is reset. The `cache` flag on strategies controls whether the decision persists _across_ execution cycles. Without it, a new cycle re-consults the strategy. With it, the same decision is reused until `reset()`.

```typescript
// Agent strategy: reuse the ordering across execution cycles until reset()
const strategy = new AgentSelectionStrategy({
  prompt: "Pick the best approach",
  agent: new ClaudeSDKAgent({ name: "strategy", model: "claude-haiku-4-5" }),
  cache: true,
});
```

Caches persist across ticks within an execution cycle, avoiding redundant agent calls. They are cleared when `reset()` is called on the tree or when a composite's cycle ends.

---

## Cost Management

Control costs with:

- `maxBudgetUsd` on the agent.
- `effort: 'low'` on the agent for simple tasks.
- `model: 'claude-haiku-4-5'` on the agent for fast, inexpensive operations.
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

## Worked Example: Classification Pipeline

This example combines structured and unstructured agent calls in a single tree. A cheap structured call classifies a support ticket, then conditional routing decides whether to escalate to a more thorough handler. For a complete, runnable version of this pattern with Zod schemas, billing analysis, and escalation handling, see the [content pipeline example](../apps/content-pipeline/).

```typescript
import { z } from "zod/v4";
import { TreeBuilder, NodeStatus, ClaudeSDKAgent } from "cartographer";

// --- Define agents ---

const classifyAgent = new ClaudeSDKAgent({
  name: "classify",
  model: "claude-haiku-4-5",
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
});

const urgentAgent = new ClaudeSDKAgent({
  name: "handle-urgent",
  model: "claude-sonnet-4-6",
  maxTurns: 5,
  maxBudgetUsd: 0.25,
});

// --- Build tree ---

const tree = new TreeBuilder("classification-pipeline")
  .sequence("classify-and-act", (b) => {
    // Step 1: Classify with structured output (fast, cheap)
    b.agent("classify", {
      agent: classifyAgent,
      prompt: (ctx) => `Classify this support ticket: ${ctx.blackboard.get<string>("ticket")}`,
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
          agent: urgentAgent,
          prompt: (ctx) => {
            const ticket = ctx.blackboard.get<string>("ticket");
            const classification = ctx.blackboard.get("classify:output");
            return `Draft an urgent response for this ${JSON.stringify(classification)} ticket: ${ticket}`;
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

- [Elicitation](guide-elicitation.md) -- Handling MCP server input requests at tree and subtree levels.
- [TreeContext and Context Layering](guide-context.md) -- How TreeContext propagates and how to override fields per subtree.
- [Leaf Nodes](guide-nodes.md) -- ActionNode, ConditionNode, and custom nodes.
- [Composites and Strategies](guide-composites.md) -- Selector, sequence, parallel, and the strategy pattern.
- [Decorator Nodes](guide-decorators.md) -- Inverter, retry, guard, timeout, and more.
- [Building Trees](guide-building-trees.md) -- TreeBuilder, nesting, and construction patterns.
- [Content Pipeline](../apps/content-pipeline/) and [Scheduled Monitor](../apps/scheduled-monitor/) -- complete runnable programs demonstrating agent nodes in realistic scenarios.
