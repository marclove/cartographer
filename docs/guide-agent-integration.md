# Agent Integration

AgentNode integrates Claude via the Agent SDK, bringing AI-powered reasoning into behavior trees. It supports two modes: **structured** for single-turn, schema-validated responses, and **agentic** for multi-turn, tool-using interactions.

---

## AgentNode Config

```typescript
interface AgentNodeConfig {
  name: string;
  mode: 'structured' | 'agentic';
  prompt: string | ((context: TreeContext) => string);

  // Structured mode
  outputSchema?: z.ZodType;
  mapResult?: (output: unknown, context: TreeContext) => NodeStatus;

  // Agentic mode
  allowedTools?: string[];
  permissionMode?: 'acceptEdits' | 'bypassPermissions' | 'default';
  maxTurns?: number;
  maxBudgetUsd?: number;
  systemPrompt?: string;
  mcpServers?: Record<string, unknown>;

  // Common
  model?: 'sonnet' | 'opus' | 'haiku';
  effort?: 'low' | 'medium' | 'high' | 'max';
  blackboardNamespace?: string;
  cache?: boolean;
}
```

Both modes share these behaviors:

- Auto-write results to `{name}:output` on the blackboard.
- Auto-attach a blackboard MCP server (read/write/keys tools).
- Emit `agent:prompt` before calling Claude and `agent:response` after.

---

## Structured Mode

Single-turn interaction. Default effort: `'low'`. When no `outputSchema` is provided, `maxTurns` is set to 1 internally. When `outputSchema` is provided, turns are uncapped so the SDK can complete structured output formatting.

Best for: classification, extraction, formatting, data transformation.

```typescript
import { AgentNode, NodeStatus } from 'cartographer';
import { z } from 'zod';

const classifier = new AgentNode({
  name: 'classify-intent',
  mode: 'structured',
  prompt: (ctx) => `Classify the following user message into one of the categories.

Message: ${ctx.blackboard.get<string>('userMessage')}`,
  model: 'haiku',
  effort: 'low',
  outputSchema: z.object({
    category: z.enum(['question', 'complaint', 'feedback', 'other']),
    confidence: z.number(),
  }),
  mapResult: (output, ctx) => {
    const result = output as { category: string; confidence: number };
    return result.confidence > 0.8 ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
  },
});
```

When `outputSchema` is provided, it is converted to JSON Schema via `z.toJSONSchema()` and passed as `outputFormat`. The structured output is available as the first argument to `mapResult` and also stored at `{name}:output`.

If `mapResult` is not provided, structured mode always returns `SUCCESS` on a successful agent call.

---

## Agentic Mode

Multi-turn interaction. Default effort: `'high'`. Supports tools, MCP servers, and system prompts.

Best for: complex reasoning, code generation, multi-step tasks, tool-using agents.

```typescript
const researcher = new AgentNode({
  name: 'research-topic',
  mode: 'agentic',
  prompt: (ctx) => `Research the following topic and write a summary.

Topic: ${ctx.blackboard.get<string>('topic')}`,
  model: 'sonnet',
  maxTurns: 10,
  maxBudgetUsd: 0.50,
  systemPrompt: 'You are a research assistant. Be thorough but concise.',
  permissionMode: 'acceptEdits',
  allowedTools: ['mcp__web__search'],
  mcpServers: {
    web: webSearchServer,
  },
});
```

Agentic mode details:

- Emits `agent:tool_use` for each tool use block in assistant messages.
- Merges user-provided `mcpServers` with the auto-attached blackboard server.
- Merges user-provided `allowedTools` with `mcp__blackboard__*`.
- Returns `SUCCESS` if the agent result subtype is `'success'`, `FAILURE` otherwise.

---

## Blackboard MCP Server

`createBlackboardMcpServer(blackboard, namespace?)` creates an MCP server that is automatically attached to every AgentNode.

```typescript
import { createBlackboardMcpServer } from 'cartographer';
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
const summarizer = new AgentNode({
  name: 'summarize',
  mode: 'structured',
  prompt: (ctx) => {
    const data = ctx.blackboard.get<string[]>('articles');
    return `Summarize these ${data?.length ?? 0} articles:\n${data?.join('\n')}`;
  },
});
```

---

## Agent Strategies

Agent strategies use Claude to make composite-level decisions. See [guide-composites.md](guide-composites.md) for the strategy pattern overview.

### Config

```typescript
interface AgentStrategyConfig {
  prompt: string | ((children: BTreeNode[], context: TreeContext) => string);
  model?: 'sonnet' | 'opus' | 'haiku';
  effort?: 'low' | 'medium' | 'high' | 'max';
  childDescriptions?: Record<string, string>;
  cache?: boolean;
}
```

### Implementations

- `AgentSelectionStrategy` -- Reorders selector children. Schema: `{ ordering: string[], reasoning: string }`.
- `AgentExecutionStrategy` -- Reorders sequence children. Schema: `{ ordering: string[], reasoning: string }`.
- `AgentParallelStrategy` -- Adjusts parallel policy. Schema: `{ policy: ParallelPolicy, reasoning: string }`.

All three use `buildStrategyPrompt()`, which constructs a prompt including child names/descriptions and current blackboard state. On agent failure, they fall back to default behavior (original order / all-must-succeed).

---

## Caching

Both `AgentNode` and the agent strategies accept a `cache: true` option.

**AgentNode caching:** When enabled, the first Claude API call is made normally, but the result is stored and returned directly on subsequent ticks without calling Claude again. The cache is cleared when `reset()` is called. This is useful in multi-tick workflows where the tree is ticked repeatedly by a scheduler with `resetBetweenTicks: false`.

```typescript
// Agent node: call Claude once, return cached status on subsequent ticks
b.agent('classify', {
  mode: 'structured',
  prompt: 'Classify this ticket',
  model: 'haiku',
  cache: true,
});
```

**Agent strategy caching:** Composites (sequence, selector) already guarantee intra-cycle order stability — the strategy is consulted once when an execution cycle starts and the order is committed until the cycle completes (SUCCESS/FAILURE) or the node is reset. The `cache` flag on strategies controls whether the decision persists *across* execution cycles. Without it, a new cycle re-consults the strategy. With it, the same decision is reused until `reset()`.

```typescript
// Agent strategy: reuse the ordering across execution cycles until reset()
const strategy = new AgentSelectionStrategy({
  prompt: 'Pick the best approach',
  model: 'haiku',
  cache: true,
});
```

Caches are cleared when the tree resets. With the scheduler, this means:

- `resetBetweenTicks: true` (default) — caches are cleared before each tick, so caching has no effect.
- `resetBetweenTicks: false` — caches persist across ticks, avoiding redundant Claude calls until the tree is explicitly reset.

---

## Cost Management

Control costs with:

- `maxBudgetUsd` on AgentNode (agentic mode only).
- `effort: 'low'` for simple tasks.
- `model: 'haiku'` for fast, inexpensive operations.
- Track spending via `agent:response` events (includes a `cost` field).

```typescript
tree.events.on('agent:response', ({ node, cost }) => {
  console.log(`${node.name}: $${cost?.toFixed(4)}`);
});
```

---

## Decision Matrix

| Criterion | Structured | Agentic |
|-----------|-----------|---------|
| Turns | Single | Multi |
| Output format | Zod schema to JSON | Free text |
| Tools | Blackboard only | Custom tools + MCP |
| Default effort | low | high |
| Cost | Lower | Higher |
| Use when | Classification, extraction, formatting | Research, code gen, complex reasoning |

---

## Worked Example: Classification Pipeline

This example combines both modes in a single tree. A cheap structured call classifies a support ticket, then conditional routing decides whether to escalate to an agentic handler. For a complete, runnable version of this pattern with Zod schemas, billing analysis, and escalation handling, see the [content pipeline example](../examples/README.md#content-pipeline).

```typescript
import { TreeBuilder, NodeStatus, AgentNode } from 'cartographer';
import { z } from 'zod';

const tree = new TreeBuilder('classification-pipeline')
  .sequence('classify-and-act', (b) => {
    // Step 1: Classify with structured agent (fast, cheap)
    b.agent('classify', {
      mode: 'structured',
      prompt: (ctx) => `Classify this support ticket: ${ctx.blackboard.get<string>('ticket')}`,
      model: 'haiku',
      effort: 'low',
      outputSchema: z.object({
        category: z.enum(['billing', 'technical', 'general']),
        urgency: z.enum(['low', 'medium', 'high']),
      }),
    });

    // Step 2: Route based on classification
    b.selector('route', (b) => {
      b.sequence('urgent-path', (b) => {
        b.condition('is-urgent', (ctx) => {
          const result = ctx.blackboard.get<{ urgency: string }>('classify:output');
          return result?.urgency === 'high';
        });
        // Step 3: Handle urgent with agentic mode (thorough)
        b.agent('handle-urgent', {
          mode: 'agentic',
          prompt: (ctx) => {
            const ticket = ctx.blackboard.get<string>('ticket');
            const classification = ctx.blackboard.get('classify:output');
            return `Draft an urgent response for this ${JSON.stringify(classification)} ticket: ${ticket}`;
          },
          model: 'sonnet',
          maxTurns: 5,
          maxBudgetUsd: 0.25,
        });
      });
      b.action('handle-normal', async (ctx) => {
        console.log('Queued for standard processing');
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
- [Examples](../examples/README.md) -- complete runnable programs demonstrating both agent modes in realistic scenarios.
