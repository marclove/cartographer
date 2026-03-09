# Examples Directory Design

## Goal

Add a Rust-style `examples/` directory with 2 substantial, fully executable examples that typecheck, can be verified by tests, and demonstrate Cartographer's capabilities to AI/LLM application developers. Examples make real Claude API calls (require `ANTHROPIC_API_KEY`).

---

## Repository Structure

```
examples/
├── README.md
├── content-pipeline/
│   ├── index.ts                    # entry point — assembles tree, ticks, prints results
│   ├── tree.ts                     # TreeBuilder definition
│   ├── actions.ts                  # action/condition functions
│   ├── schemas.ts                  # Zod schemas for structured agent outputs
│   ├── prompts.ts                  # prompt strings/functions for agent nodes
│   └── content-pipeline.test.ts
├── scheduled-monitor/
│   ├── index.ts                    # entry point — sets up scheduler, starts, prints dashboard
│   ├── tree.ts                     # TreeBuilder definition
│   ├── actions.ts                  # health check actions, history management, incident state
│   ├── schemas.ts                  # Zod schemas (assessment, incident report, etc.)
│   ├── prompts.ts                  # prompt strings/functions
│   ├── server.ts                   # local HTTP test server with failure simulation
│   └── scheduled-monitor.test.ts
```

**Run command:** `npx tsx examples/content-pipeline/index.ts`

**File separation rationale:**
- `tree.ts` — the architecture; shows tree structure at a glance without implementation noise
- `actions.ts` — deterministic logic; pure functions that read/write blackboard
- `schemas.ts` — Zod schemas, reusable and reviewable on their own
- `prompts.ts` — prompt engineering separate from tree wiring
- `index.ts` — orchestration glue: construct, run, report

---

## Example 1: Content Pipeline

**Scenario:** Support ticket triage system. Takes a raw customer support ticket, classifies it, routes through specialized handling branches, produces a structured response.

### Tree Structure

```
sequence "triage-pipeline"
├── agent "classify" (structured, haiku)
│   └── outputs: { category, urgency, language }
├── selector "route-by-category"
│   ├── sequence "billing-path"
│   │   ├── condition "is-billing"
│   │   ├── agent "lookup-account" (structured, haiku)
│   │   └── agent "draft-billing-response" (agentic, sonnet)
│   ├── sequence "technical-path"
│   │   ├── condition "is-technical"
│   │   ├── retry { maxAttempts: 2 }
│   │   │   └── agent "diagnose-issue" (agentic, sonnet)
│   │   └── agent "draft-technical-response" (structured, sonnet)
│   └── sequence "general-path"
│       ├── condition "is-general"
│       └── agent "draft-general-response" (structured, haiku)
├── guard { condition: is-urgent }
│   └── agent "escalation-summary" (structured, haiku)
└── action "emit-result"
    └── reads blackboard, prints final triage report
```

### Features Demonstrated

- **Structured mode** for classification with Zod schema and `mapResult`
- **Agentic mode** for open-ended reasoning (diagnosis, drafting)
- **Selector with conditions** for routing based on agent output
- **Retry decorator** around agent calls
- **Guard decorator** for conditional escalation (only runs if urgent)
- **Blackboard as data bus** — each agent writes output that downstream nodes read
- **Event listeners** — subscribes to `node:enter`, `node:exit`, `agent:response` for execution trace with timing and cost

### Input/Output

**Input:** Hardcoded realistic support ticket string set on blackboard before ticking.

**Output:** Structured triage report: classification, drafted response, escalation note if urgent, total cost.

---

## Example 2: Scheduled Monitor

**Scenario:** Multi-service health monitor that checks several endpoints in parallel, uses an agent to assess overall system health from patterns, and manages a full incident lifecycle.

### Tree Structure

```
sequence "health-monitor"
├── parallel "check-all-services" { successCount: all }
│   ├── action "check-api"
│   ├── action "check-database"
│   └── action "check-queue"
│       └── each writes { healthy, statusCode, latencyMs } namespaced per service
├── action "update-history"
│   └── maintains rolling window per service, computes aggregate stats
├── timeout { ms: 10_000 }
│   └── agent "assess-health" (structured, haiku)
│       └── schema: { status: 'healthy'|'degraded'|'outage', reasoning, affectedServices[] }
│       └── prompt includes full history window for trend detection
├── selector "respond-to-assessment"
│   ├── sequence "outage-path"
│   │   ├── condition "is-outage"
│   │   ├── selector "outage-actions"
│   │   │   ├── sequence "new-outage"
│   │   │   │   ├── condition "no-active-incident"
│   │   │   │   └── agent "draft-incident-report" (agentic, sonnet)
│   │   │   └── sequence "ongoing-outage"
│   │   │       ├── guard { condition: enough-time-since-last-update }
│   │   │       └── agent "draft-status-update" (structured, haiku)
│   │   └── action "record-incident-tick"
│   ├── sequence "recovery-path"
│   │   ├── condition "was-down-now-healthy"
│   │   ├── agent "draft-resolution-summary" (structured, sonnet)
│   │   └── action "clear-incident-state"
│   └── action "log-healthy"
```

### Features Demonstrated

- **TreeScheduler** with interval scheduling and `resetBetweenTicks: false`
- **Parallel node** checking three simulated services concurrently
- **Timeout decorator** around the assessment agent
- **Agent as analyst** — assessment agent sees full history window, classifies based on patterns (gradual degradation, flapping, partial outages)
- **Full incident lifecycle** — new incident, ongoing status updates (throttled by guard), resolution summary
- **Stateful blackboard** accumulating per-service history across ticks
- **Guard decorator** preventing duplicate incident reports
- **Selector routing** — outage, recovery, and healthy as mutually exclusive paths
- **Scheduler events** — `tick:start`, `tick:complete`, `scheduler:stop` for live dashboard output

### Local Test Server

Self-contained HTTP server simulating three services with different failure profiles:
- One that goes down hard
- One that degrades gradually (increasing latency)
- One that flaps

### Scheduler Config

```typescript
new TreeScheduler({
  tree,
  schedule: { type: 'interval', ms: 15_000 },
  resetBetweenTicks: false,
  maxRuns: 10,
  onError: 'continue',
})
```

### Output

Live tick-by-tick console dashboard with per-service status. Agent-drafted reports and updates printed on state transitions. Final summary with total ticks, incidents detected, cost breakdown.

---

## Testing Strategy

### Test Files

Each example gets a `.test.ts` companion that:
- Imports and executes the example's main function
- Asserts it doesn't throw
- Optionally asserts key blackboard keys are populated (classification exists, agent outputs have expected shape)
- Does not assert on Claude's content — only structural correctness

### Vitest Config

Fourth vitest project added:

```typescript
{
  test: {
    name: 'examples',
    include: ['examples/**/*.test.ts'],
  },
}
```

### Package.json

New script: `"test:examples": "vitest run --project examples"`

`test:all` updated to include examples.

### Typecheck

`examples/tsconfig.json` extending root config with adjusted `include`/`rootDir`. Typecheck script updated to: `tsc --noEmit && tsc --noEmit -p examples/tsconfig.json`.

---

## Decisions

- **Live-only** — examples make real Claude API calls, require `ANTHROPIC_API_KEY`
- **Target audience** — AI/LLM application developers; automation features shown in service of agent orchestration
- **Standalone execution** — `npx tsx examples/<name>/index.ts`
- **Multi-file organization** — single responsibility per file, demonstrating best practices
- **Import path** — examples import from `../src/index.js` (source, resolved by tsx without build step)
