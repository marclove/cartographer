# Cartographer

**Structured orchestration for AI agent applications.**

Cartographer is a TypeScript framework for building applications where AI agents operate within defined, observable workflows. You design the orchestration — what runs, in what order, with what fallbacks — and agents handle the parts that require intelligence. The result is software that's both capable and dependable.

Most agentic frameworks are designed for fully-automated pipelines or local CLI/TUI tools. Cartographer takes a different approach: it's an application framework for production systems where humans and AI collaborate. The behavior tree gives you stronger guarantees than unconstrained agent loops — sequences, selectors, guards, and timeouts enforce workflow structure while agents decide tactics at strategic decision points. You can always explain exactly what path the tree took and why.

The actor framework turns trees into persistent HTTP services with SSE event streams and client SDKs for React, Svelte, or plain fetch. Build real applications where frontends connect to AI-driven backends in real time — contract negotiation tools where agents draft and humans approve, multi-step onboarding flows that adapt to each user, fraud investigation workbenches that surface evidence and wait for analyst decisions, collaborative writing environments, logistics coordinators that replan routes when constraints change, or clinical trial matching systems where AI screens candidates and physicians make final calls.

```bash
npm install cartographer
```

## A Quick Example

A support ticket pipeline that classifies incoming tickets, routes them to specialized agents, retries on failure, and optionally escalates urgent cases:

```typescript
import { z } from 'zod/v4';
import { TreeBuilder, NodeStatus } from 'cartographer';

const tree = new TreeBuilder('support-pipeline')
  .sequence('triage', (b) => {
    // Step 1: AI classifies the ticket
    b.agent('classify', {
      prompt: (ctx) => `Classify this support ticket:\n${ctx.blackboard.get('ticket')}`,
      options: {
        model: 'claude-haiku-4-5',
        outputFormat: {
          type: 'json_schema',
          schema: z.toJSONSchema(
            z.object({
              category: z.enum(['billing', 'technical', 'general']),
              urgency: z.enum(['low', 'medium', 'high']),
            }),
          ) as any,
        },
      },
    });

    // Step 2: Route to the right handler — first match wins
    b.selector('route', (b) => {
      b.sequence('billing-path', (b) => {
        b.condition('is-billing', (ctx) => {
          const c = ctx.blackboard.get<{ category: string }>('classify:output');
          return c?.category === 'billing';
        });
        b.retry('billing-retry', { maxAttempts: 2 }, (b) => {
          b.agent('handle-billing', {
            prompt: (ctx) => `Draft a billing resolution for:\n${ctx.blackboard.get('ticket')}`,
            options: { model: 'claude-sonnet-4-6' },
          });
        });
      });

      b.sequence('technical-path', (b) => {
        b.condition('is-technical', (ctx) => {
          const c = ctx.blackboard.get<{ category: string }>('classify:output');
          return c?.category === 'technical';
        });
        b.agent('diagnose', {
          prompt: (ctx) => `Diagnose this technical issue:\n${ctx.blackboard.get('ticket')}`,
          options: { model: 'claude-sonnet-4-6', maxTurns: 10 },
        });
      });

      // Default path — always succeeds as the final branch
      b.agent('handle-general', {
        prompt: (ctx) => `Draft a helpful response to:\n${ctx.blackboard.get('ticket')}`,
        options: { model: 'claude-haiku-4-5' },
      });
    });

    // Step 3: Escalation runs only for urgent tickets; wrapped so it
    // can't fail the pipeline even if the agent errors
    b.alwaysSucceed('optional-escalation', (b) => {
      b.guard('urgency-gate', {
        condition: (ctx) => {
          const c = ctx.blackboard.get<{ urgency: string }>('classify:output');
          return c?.urgency === 'high';
        },
      }, (b) => {
        b.agent('escalate', {
          prompt: 'Summarize the ticket and recommended actions for the on-call team.',
          options: { model: 'claude-haiku-4-5' },
        });
      });
    });
  })
  .build();

// Run the tree
tree.blackboard.set('ticket', 'I was charged twice for my subscription last month.');
const { status, blackboard } = await tree.run();
```

This tree is fully deterministic in its control flow. The routing, retries, guards, and error containment all behave predictably. Only the agent calls — classification, diagnosis, response drafting — involve AI. Every step emits structured events, so you can observe and debug the entire pipeline.

## Why Cartographer?

**Structured orchestration, not prompt chains.** Workflows are composed from small, testable nodes arranged in a tree. Sequences run steps in order. Selectors try alternatives until one works. Parallel nodes run tasks concurrently. Each pattern is a building block you can combine and nest arbitrarily.

**Resilience is built in.** Retry failed steps, enforce timeouts, guard branches behind conditions, wrap unreliable paths so they can't take down the pipeline. Errors never crash the tree — they convert to failures that parent nodes can react to. Abort signals propagate cleanly through async work.

**Observable by default.** Every node tick, agent call, tool use, blackboard mutation, and strategy decision emits a typed event. Stream these to dashboards, logging systems, or client applications over SSE. Production-grade NDJSON structured logging makes every decision traceable and queryable. A real-time dashboard provides tree visualization, an event timeline, and a blackboard inspector.

**Persistent, interactive sessions.** The actor framework turns trees into long-running, message-driven applications. State serializes between requests. Frontends connect via a client SDK with SSE streaming. Trees can pause and wait for user input, making human-in-the-loop workflows a first-class pattern.

**Full Claude Agent SDK integration.** Agent nodes invoke Claude with structured output, tool use, budget controls, and MCP servers. A built-in MCP server gives agents read/write access to the workflow's shared state, so agents can both consume and produce data that other nodes use. Agent strategies let AI make runtime control flow decisions — selecting which branch to take or reordering children — within the tree's structural constraints.

## Building Interactive Applications

Cartographer's actor framework turns workflows into persistent HTTP services. Trees can pause, wait for user decisions, and resume — enabling applications where humans and agents collaborate in real time.

```typescript
import {
  ActorServer, BehaviorTree, SequenceNode, SelectorNode,
  NodeStatus, actionReceived, untilSuccess, emitToClient,
} from 'cartographer';

const server = new ActorServer({
  createTree: () => new BehaviorTree({
    name: 'review-flow',
    root: new SequenceNode({
      name: 'main',
      children: [
        // Agent analyzes the document (AgentNode omitted for brevity)
        // ...

        // Send findings to the connected client
        emitToClient('show-review', (ctx) => ({
          findings: ctx.blackboard.get('analysis'),
        })),

        // Pause the tree and wait for a user decision
        untilSuccess(
          new SelectorNode({
            name: 'await-decision',
            children: [
              actionReceived('approve'),
              actionReceived('reject'),
            ],
          }),
        ),
      ],
    }),
  }),
  port: 3148,
});

await server.start();
```

On the client side, React hooks connect your UI to the running tree. State streams in over SSE; actions flow back over HTTP. No manual event wiring — hooks handle the lifecycle.

```tsx
import { useState } from 'react';
import {
  CartographerProvider, useAction, useClientEvent, useTreeStatus,
} from '@cartographer/react';

function App() {
  return (
    <CartographerProvider url="http://localhost:3148">
      <ReviewApp />
    </CartographerProvider>
  );
}

function ReviewApp() {
  const [findings, setFindings] = useState<string[] | null>(null);
  const approve = useAction('approve');
  const reject = useAction('reject');
  const tree = useTreeStatus();

  // The tree pushes findings to the client when analysis is done
  useClientEvent('show-review', (data) => {
    setFindings((data as { findings: string[] }).findings);
  });

  if (!findings) return <p>Analyzing document{tree?.status === 'running' ? '...' : ''}</p>;

  return (
    <div>
      <h2>Review Findings</h2>
      <ul>
        {findings.map((f, i) => <li key={i}>{f}</li>)}
      </ul>
      <button onClick={() => approve.send({ comment: 'Ship it' })} disabled={approve.pending}>
        {approve.pending ? 'Submitting...' : 'Approve'}
      </button>
      <button onClick={() => reject.send()} disabled={reject.pending}>
        Reject
      </button>
    </div>
  );
}
```

Svelte 5 runes (`@cartographer/svelte`) and the raw client SDK (`@cartographer/client`) are also available for non-React frontends or server-to-server communication.

State persists across requests. The tree rehydrates from a state store on each message, runs to completion or suspension, then serializes back. In-memory storage works for development; Redis is available for production.

## Scheduled Operations

`TreeScheduler` runs trees on intervals or cron schedules, with overlap protection, cycle limits, and configurable error policies:

```typescript
import { TreeScheduler } from 'cartographer';

const scheduler = new TreeScheduler({
  tree,
  schedule: { type: 'interval', delayMs: 60_000 },
  onError: 'continue',
});

await scheduler.start();
```

## Packages

| Package | Description |
|---------|-------------|
| `cartographer` | Core framework — nodes, composites, decorators, strategies, scheduler, actor, server, CLI |
| `@cartographer/client` | Browser/Node client SDK for ActorServer (fetch + EventSource) |
| `@cartographer/react` | React 19 hooks for connecting components to behavior trees |
| `@cartographer/svelte` | Svelte 5 runes for connecting components to behavior trees |

## Getting Started

```bash
npm install cartographer
```

Requires Node.js 18+. An Anthropic API key is required for agent features (set `ANTHROPIC_API_KEY`).

```typescript
import { TreeBuilder, NodeStatus } from 'cartographer';

const tree = new TreeBuilder('hello')
  .sequence('main', (b) => {
    b.action('greet', (ctx) => {
      ctx.blackboard.set('message', 'Hello from Cartographer');
      return NodeStatus.SUCCESS;
    });
    b.agent('expand', {
      prompt: (ctx) => `Elaborate on: ${ctx.blackboard.get('message')}`,
      options: { model: 'claude-haiku-4-5' },
    });
  })
  .build();

const { status, blackboard } = await tree.run();
```

Cartographer also includes a CLI for running and inspecting trees:

```bash
npx cartographer run ./my-tree.ts
npx cartographer inspect ./my-tree.ts
```

## Documentation

Comprehensive guides are available in the [`docs/`](docs/) directory:

- [Quick Start](docs/getting-started.md) — Install and build your first tree
- [Core Concepts](docs/concepts.md) — Execution model, node statuses, tick lifecycle
- [Building Trees](docs/guide-building-trees.md) — Builder API, registry, and direct instantiation
- [Nodes](docs/guide-nodes.md) — ActionNode, ConditionNode, AgentNode
- [Composites](docs/guide-composites.md) — Sequence, selector, and parallel nodes
- [Decorators](docs/guide-decorators.md) — Retry, timeout, guard, inverter, and more
- [Agent Integration](docs/guide-agent-integration.md) — AgentNode, structured output, MCP tools
- [State and Observability](docs/guide-blackboard-and-events.md) — Shared state and the event system
- [Context Layering](docs/guide-context.md) — TreeContext propagation and per-subtree overrides
- [Error Handling](docs/guide-error-handling.md) — Error containment, recovery patterns, abort signals
- [Actor Framework](docs/guide-actor-framework.md) — Persistent sessions, HTTP server, client SDK
- [Scheduling](docs/guide-scheduler.md) — Interval, cron, and one-shot execution
- [CLI Runner](docs/guide-cli.md) — Running, inspecting, and scaffolding trees
- [Elicitation](docs/guide-elicitation.md) — Handling MCP server input requests
- [Testing](docs/guide-testing.md) — Test contexts, event verification, multi-tick patterns
- [Advanced Patterns](docs/guide-advanced-patterns.md) — Custom nodes, custom strategies, multi-tick resumption
- [Svelte Integration](docs/guide-svelte.md) — Svelte 5 runes for reactive UI
- [React Integration](docs/guide-react.md) — React hooks for tree state and events
- [API Reference](docs/api/index.md) — Complete API documentation

Two complete example applications are included:
- [`apps/content-pipeline/`](apps/content-pipeline/) — Multi-agent support ticket triage with routing, retries, and structured output
- [`apps/scheduled-monitor/`](apps/scheduled-monitor/) — Health monitoring with incident management on a scheduled loop

## Contributing

### Setup

```bash
git clone https://github.com/marclove/cartographer-ts
cd cartographer
pnpm install
```

### Development Commands

```bash
pnpm run build            # Build all packages (via turbo)
pnpm run test             # Run unit tests across all packages
pnpm run test:integration # Run integration tests (cartographer package)
pnpm run test:live        # Run live API tests (requires ANTHROPIC_API_KEY)
pnpm run typecheck        # Type-check all packages
```

To run a single test file:

```bash
pnpm --filter cartographer exec vitest run src/nodes/action.test.ts
```

### Project Structure

```
packages/
  cartographer/    # Core behavior tree framework
  client/          # Browser/Node client SDK (@cartographer/client)
  react/           # React hooks (@cartographer/react)
  svelte/          # Svelte 5 runes (@cartographer/svelte)
apps/
  dashboard/       # Svelte dashboard app (@cartographer/dashboard)
  content-pipeline/   # Example: support ticket triage pipeline
  scheduled-monitor/  # Example: scheduled health monitor
```

### Testing

Unit tests live alongside their source files (`src/**/*.test.ts`). Integration tests live in `src/__integration__/` and are split into two categories:

- **Deterministic tests** — Exercise multi-component workflows (retry + timeout + sequence, scheduler resumption, config-driven trees, etc.) and always run.
- **Agent SDK tests** — Make real Claude API calls and require an `ANTHROPIC_API_KEY` environment variable. They are automatically skipped when the key is not set.

```bash
# Run deterministic integration tests
pnpm run test:integration

# Run live API tests (requires an Anthropic API key)
ANTHROPIC_API_KEY=sk-... pnpm run test:live
```

### Tech Stack

- TypeScript (ES2022, ESM-only)
- [Vitest](https://vitest.dev/) for testing
- [Zod](https://zod.dev/) v4 for schema validation
- [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) for AI integration

## License

Apache-2.0
