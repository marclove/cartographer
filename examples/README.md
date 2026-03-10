# Examples

Runnable examples demonstrating Cartographer's capabilities. Each example is a self-contained TypeScript program that makes real Claude API calls and exercises the framework end-to-end.

## Prerequisites

- Node.js >= 18
- `npm install` (from repo root)
- `ANTHROPIC_API_KEY` environment variable set

## Running

```bash
npx tsx examples/content-pipeline/index.ts
npx tsx examples/scheduled-monitor/index.ts
```

## Content Pipeline

**File:** `examples/content-pipeline/`

A support ticket triage system. Takes a raw customer support ticket, classifies it with a structured agent, routes it through specialized handling branches (billing, technical, general), and optionally escalates urgent tickets.

**Framework features exercised:**

- `TreeBuilder` fluent API for tree construction
- `AgentNode` in structured mode (classification, analysis, response drafting)
- `AgentNode` in unstructured mode (billing response drafting, technical diagnosis)
- Zod output schemas for typed structured output
- Selector-based routing with condition nodes
- Retry decorator around agent calls
- Guard decorator for conditional escalation
- AlwaysSucceed decorator for optional pipeline steps
- Blackboard as a data bus between agents
- Event listeners for execution tracing and cost tracking

**Cost:** Approximately $0.01–0.05 per run (haiku for classification/analysis, sonnet for response drafting).

## Scheduled Monitor

**File:** `examples/scheduled-monitor/`

A multi-service health monitor that periodically checks three endpoints in parallel, uses an agent to assess overall system health from historical patterns, and manages a full incident lifecycle — detection, severity classification, periodic status updates, and resolution summaries.

Includes a local HTTP server that simulates three services with different failure profiles (hard outage, gradual degradation, flapping) to create realistic state transitions.

**Framework features exercised:**

- `TreeScheduler` with interval scheduling and `resetBetweenTicks: false`
- Parallel node for concurrent service health checks
- Stateful blackboard accumulating health history across ticks
- Timeout decorator around the assessment agent
- AlwaysSucceed decorator for graceful timeout fallback
- Guard decorator for throttling status updates
- Selector-based routing (unhealthy, recovery, healthy paths)
- Structured agents for health assessment, incident reports, status updates, and resolution summaries
- Scheduler events for live dashboard output

**Cost:** Approximately $0.02–0.05 per run (8 ticks, all haiku).

**Runtime:** ~2 minutes (8 ticks at 10-second intervals).

## Testing

Examples are verified by a dedicated vitest project:

```bash
npm run test:examples    # Run example tests (requires ANTHROPIC_API_KEY)
npm run typecheck        # Typechecks examples alongside source
```
