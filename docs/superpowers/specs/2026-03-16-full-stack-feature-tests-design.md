# Full-Stack Feature Tests Design

## Problem

The `setupTest` harness enables full-stack integration testing (client SDK → ActorServer → TreeActor → BehaviorTree → nodes), but no tests exercise it yet. The existing integration tests predate the actor framework and test tree behavior in isolation. We need high-value feature tests that build realistic, multi-node behavior trees and verify that the full stack works together correctly across multiple client interactions.

## Approach

7 tests, each anchored to a primary integration point but built around a realistic workflow tree (6-10+ nodes). Each test is one file, named after the functionality being verified. 5 are deterministic (no API keys), 2 are live (require `ANTHROPIC_API_KEY`).

All tests use `await using harness = await setupTest(...)` for setup and automatic teardown.

## Prerequisite: Bridge `client:event` in ActorServer

The `ActorServer` currently only forwards `message:processed`, `message:interrupted`, and `message:failed` events to the SSE stream. Tree-level events like `client:event` (emitted by `emitToClient`) are not bridged. The client SDK already has listener wiring for `client:event`, but the events never arrive over the wire.

Before these tests can verify `emitToClient` via SSE, the `ActorServer` must forward `client:event` events from the tree's event emitter to the state store's event stream during processing. This is a small framework change: during `TreeActor.process()`, tree events of type `client:event` should be appended to the event store alongside the existing `message:*` events.

## Deterministic Tests

### 1. `multi-step-action-workflow.test.ts`

**Anchor:** Suspension and resumption via `actionReceived` / `untilSuccess`

**Tree:** Document review pipeline.

```
Sequence("review-pipeline")
  ├── ActionNode("analyze")         — writes { summary, issues } to blackboard
  ├── emitToClient("ui:findings", (ctx) => ctx.blackboard.get('analysis'))  — sends findings to client
  ├── untilSuccess(
  │     Selector("wait-decision")
  │       ├── actionReceived("approve")
  │       └── actionReceived("reject")
  │   )
  └── Selector("handle-decision")
        ├── Sequence("approved-path")
        │     ├── ConditionNode("was-approved") — checks blackboard for actions:approve consumed
        │     └── ActionNode("publish")         — writes { published: true }
        └── ActionNode("archive")               — writes { archived: true }
```

**Note on decision routing:** The `actionReceived` nodes consume their action keys from the blackboard. The `handle-decision` selector can detect which action was taken by checking what state the earlier nodes left behind — for example, by having `mapPayload` on each `actionReceived` write a `decision` key to the blackboard, then routing with a condition that reads it.

**Client interactions:**
1. `client.send({ type: 'tick' })` — starts pipeline, analyze runs, emits findings, suspends at `untilSuccess`
2. Verify `ui:findings` client event received with `{ summary, issues }`
3. `client.actionAndWait('approve', { comment: 'LGTM' })` — resumes, approve consumed, publish runs
4. Verify blackboard: `published === true`, `decision === 'approve'`

**Features exercised:** Sequence resumption across messages (analyze not re-executed after resume), `actionReceived` consuming actions, `untilSuccess` suspension, `emitToClient` dual write (SSE event + blackboard), `mapPayload` extracting data, blackboard state flowing between steps.

---

### 2. `interrupt-redirect-resume.test.ts`

**Anchor:** Interrupt lifecycle and held state

**Tree:** Research pipeline.

```
Sequence("research-pipeline")
  ├── ActionNode("gather-context")     — reads topic from blackboard, writes context summary (fast, ~10ms)
  ├── ActionNode("deep-analysis")      — slow action (~500ms), reads context, writes analysis
  ├── ActionNode("synthesize")         — combines context + analysis, writes final report
  └── emitToClient("ui:report", (ctx) => ctx.blackboard.get('report'))  — sends report to client
```

**Client interactions:**
1. `client.send({ type: 'tick' })` — starts pipeline, gather-context completes, deep-analysis begins
2. Wait briefly (~50ms) for deep-analysis to be in-flight
3. `client.interrupt()` — interrupts deep-analysis mid-execution
4. Verify: `interrupted === true`, tree is held
5. `client.send({ type: 'tick' })` — verify no-op (returns held: true)
6. `client.write('topic', 'new-topic')` — clears held, writes new topic
7. Wait for `message:processed` — tree resumes from deep-analysis (gather-context cached, not re-run)
8. Verify blackboard: final report reflects new topic, gather-context ran once total

**Features exercised:** Interrupt canceling in-flight async work, held state blocking tick messages, write message clearing held flag, sequence `completedMap` preservation across interrupt (gather-context not re-executed), blackboard state across interrupt boundary.

---

### 3. `parallel-approval-policy.test.ts`

**Anchor:** Parallel node with success policy and early termination

**Tree:** Multi-reviewer approval flow.

```
Sequence("approval-flow")
  ├── ActionNode("prepare-review")     — writes review materials to blackboard
  ├── Parallel("reviewers", { strategy: new DefaultParallelStrategy({ successCount: 2, failureCount: 2 }) })
  │     ├── Sequence("reviewer-1")
  │     │     ├── emitToClient("ui:review-request-1", () => ({ reviewer: 'alice' }))
  │     │     └── untilSuccess(actionReceived("reviewer-1"))
  │     ├── Sequence("reviewer-2")
  │     │     ├── emitToClient("ui:review-request-2", () => ({ reviewer: 'bob' }))
  │     │     └── untilSuccess(actionReceived("reviewer-2"))
  │     └── Sequence("reviewer-3")
  │           ├── emitToClient("ui:review-request-3", () => ({ reviewer: 'charlie' }))
  │           └── untilSuccess(actionReceived("reviewer-3"))
  └── ActionNode("publish")            — writes { published: true, approvers }
```

**Client interactions:**
1. `client.send({ type: 'tick' })` — starts flow, prepare-review runs, all 3 reviewer sequences start in parallel, each emits a client event then suspends
2. Verify 3 `ui:review-request-*` client events received
3. `client.actionAndWait('reviewer-1', { verdict: 'approve' })` — reviewer-1 sequence completes, but parallel still RUNNING (need 2)
4. Verify tree still RUNNING
5. `client.actionAndWait('reviewer-2', { verdict: 'approve' })` — reviewer-2 completes, policy satisfied (2 of 3), parallel returns SUCCESS, publish runs
6. Verify blackboard: `published === true`, reviewer-3 was not waited on

**Features exercised:** Parallel concurrent execution, `successCount` policy, early termination without waiting for all children, `untilSuccess` suspension within parallel children, `emitToClient` from parallel branches, sequence after parallel, `actionReceived` in concurrent context.

---

### 4. `selector-preemption-reactive.test.ts`

**Anchor:** Selector preemption via reactive condition

**Tree:** Deploy-with-rollback pipeline. Each deploy stage requires explicit user confirmation via `actionReceived`, creating suspension points where the client can inject an error before the next stage begins.

```
Sequence("deploy-pipeline")
  ├── ActionNode("plan-deploy")        — writes deploy plan to blackboard (fast)
  └── Selector("execute-or-rollback")
        ├── Sequence("deploy-path")
        │     ├── Guard("no-errors", condition: bb.get('error') == null)
        │     ├── ActionNode("provision")   — writes { provisioned: true }
        │     ├── untilSuccess(actionReceived("confirm-provision"))
        │     ├── Guard("still-no-errors", condition: bb.get('error') == null)
        │     ├── ActionNode("configure")   — writes { configured: true }
        │     ├── untilSuccess(actionReceived("confirm-configure"))
        │     └── ActionNode("activate")    — writes { activated: true }
        └── Sequence("rollback-path")
              ├── ActionNode("revert")      — writes { reverted: true }
              └── emitToClient("ui:rollback-complete", (ctx) => ({ reverted: ctx.blackboard.get('reverted') }))
```

**Client interactions:**
1. `client.send({ type: 'tick' })` — starts pipeline, plan-deploy completes, deploy-path begins, guard passes, provision runs, suspends at confirm-provision
2. `client.actionAndWait('confirm-provision')` — resumes, second guard passes, configure runs, suspends at confirm-configure
3. `client.write('error', 'critical failure detected')` — writes error to blackboard, tree ticks: guard "still-no-errors" re-evaluates on next tick, fails, deploy-path sequence fails, selector falls through to rollback-path
4. Wait for `message:processed` — revert runs, rollback-complete emitted
5. Verify blackboard: `provisioned === true`, `configured === true`, `activated` absent, `reverted === true`
6. Verify `ui:rollback-complete` client event received

**Features exercised:** Selector fallback when first branch fails, reactive guard re-evaluation across messages, guard failing mid-sequence causing sequence failure, blackboard write triggering path change, deploy-path partial state preserved on blackboard (provision and configure happened, activate did not), `emitToClient` on rollback path, multiple suspension points via `actionReceived`.

---

### 5. `client-event-driven-wizard.test.ts`

**Anchor:** Multi-stage wizard with `emitToClient`, retry, and accumulated blackboard state

**Tree:** 3-step onboarding wizard with validation and retry.

```
Sequence("onboarding-wizard")
  ├── Retry("step-1-retry", { maxAttempts: 3 })
  │     └── Sequence("step-1")
  │           ├── emitToClient("ui:form", () => ({ step: 1, fields: ['name', 'email'] }))
  │           ├── untilSuccess(actionReceived("step-1", { mapPayload: writes to wizard:step-1 }))
  │           └── ConditionNode("validate-step-1") — checks name non-empty
  ├── Retry("step-2-retry", { maxAttempts: 3 })
  │     └── Sequence("step-2")
  │           ├── emitToClient("ui:form", () => ({ step: 2, fields: ['company', 'role'] }))
  │           ├── untilSuccess(actionReceived("step-2", { mapPayload: writes to wizard:step-2 }))
  │           └── ConditionNode("validate-step-2") — checks company non-empty
  ├── Retry("step-3-retry", { maxAttempts: 3 })
  │     └── Sequence("step-3")
  │           ├── emitToClient("ui:form", () => ({ step: 3, fields: ['plan'] }))
  │           ├── untilSuccess(actionReceived("step-3", { mapPayload: writes to wizard:step-3 }))
  │           └── ConditionNode("validate-step-3") — checks plan is 'starter' or 'pro'
  └── Sequence("finalize")
        ├── ActionNode("create-account")   — reads all wizard:* keys, writes account record
        └── emitToClient("ui:confirmation") — sends complete account data
```

**Client interactions:**
1. `client.send({ type: 'tick' })` — starts wizard, emits step 1 form, suspends
2. Verify `ui:form` event with `{ step: 1, fields: ['name', 'email'] }`
3. `client.actionAndWait('step-1', { name: '', email: 'bad' })` — validation fails, retry kicks in, step 1 form re-emitted
4. `client.actionAndWait('step-1', { name: 'Alice', email: 'alice@co.com' })` — validation passes, step 2 form emitted
5. `client.actionAndWait('step-2', { company: 'Acme', role: 'eng' })` — validation passes, step 3 form emitted
6. `client.actionAndWait('step-3', { plan: 'pro' })` — validation passes, account created, confirmation emitted
7. Verify `ui:confirmation` event with all 3 stages' data aggregated
8. Verify blackboard: `wizard:step-1`, `wizard:step-2`, `wizard:step-3` all populated, account record created

**Features exercised:** `emitToClient` at multiple points in sequence, `mapPayload` writing structured data to scoped blackboard keys, retry decorator re-executing failed stage (validation failure → retry), condition node validation, blackboard accumulating state across 6+ messages, sequence resumption through 3 stages (earlier stages not re-executed).

---

## Live Tests

### 6. `live/agent-structured-pipeline.test.ts`

**Anchor:** Real AgentNode with structured output in a conditional workflow

**Tree:** Content classification pipeline.

```
Sequence("classification-pipeline")
  ├── ActionNode("ingest-document")    — writes document text to blackboard
  ├── AgentNode("classify", {
  │     prompt: "Classify the document on the blackboard...",
  │     options: { outputFormat: { type: 'json_schema', schema: { category: string, confidence: number, tags: string[] } } },
  │     blackboardNamespace: "classifier"
  │   })
  └── Selector("confidence-routing")
        ├── Sequence("high-confidence")
        │     ├── ConditionNode("is-confident") — checks classifier:classify:output.confidence > 0.8
        │     ├── ActionNode("auto-publish")    — writes { published: true, auto: true }
        │     └── emitToClient("ui:published", (ctx) => ctx.blackboard.get('classifier:classify:output'))
        └── Sequence("low-confidence")
              ├── emitToClient("ui:needs-review", (ctx) => ctx.blackboard.get('classifier:classify:output'))
              ├── untilSuccess(
              │     Selector("review-decision")
              │       ├── actionReceived("confirm-classification")
              │       └── actionReceived("reclassify")
              │   )
              └── ActionNode("manual-publish")  — writes { published: true, auto: false }
```

**Client interactions:**
1. `client.send({ type: 'tick' })` — ingests document, starts agent classification
2. Wait for tree to settle (agent call completes) — either auto-publishes or requests review
3. If high confidence: verify `ui:published` event, blackboard has `published: true, auto: true`
4. If low confidence: verify `ui:needs-review` event with classification data, then `client.actionAndWait('confirm-classification')`, verify `published: true, auto: false`
5. In both paths: verify `classifier:classify:output` on blackboard has the expected shape (`category`, `confidence`, `tags` fields)

**Features exercised:** Real Claude SDK call, `options.outputFormat` structured output, `blackboardNamespace` scoping agent output, condition branching on agent output, `emitToClient` on both paths, `actionReceived` on low-confidence path, sequence resumption.

**Test considerations:** The test should handle both paths (high and low confidence) since the agent's response is non-deterministic. Assert on structural properties (schema shape, published state) rather than specific classification values.

---

### 7. `live/agent-interrupt-and-redirect.test.ts`

**Anchor:** Real AgentNode interrupted and redirected with new context

**Tree:** Research assistant pipeline. The agent reads the topic directly from the blackboard via a dynamic prompt function, so after interrupt + redirect, the agent picks up the new topic without needing a `prepare-context` step (which would be cached in `completedMap` and not re-run).

```
Sequence("research-assistant")
  ├── untilSuccess(actionReceived("set-topic", { mapPayload: writes to research:topic }))
  ├── AgentNode("research", {
  │     prompt: (ctx) => `Research the following topic: ${ctx.blackboard.get('research:topic')}`,
  │     options: { outputFormat: { type: 'json_schema', schema: { summary: string, keyFindings: string[] } } },
  │     blackboardNamespace: "researcher"
  │   })
  ├── ActionNode("format-report")      — reads researcher:research:output, writes formatted report
  └── emitToClient("ui:report", (ctx) => ctx.blackboard.get('report'))  — sends report to client
```

**Client interactions:**
1. `client.actionAndWait('set-topic', { topic: 'behavioral trees in robotics' })` — topic set, agent starts researching
2. Wait briefly (~2s) for the agent to be in-flight
3. `client.interrupt()` — interrupts agent mid-research
4. Verify: `interrupted === true`
5. `client.write('research:topic', 'behavior trees in game AI')` — clears held, writes new topic
6. Wait for `message:processed` — agent restarts, reads new topic from blackboard via dynamic prompt
7. Wait for eventual completion — agent finishes, report emitted
8. Verify `researcher:research:output` exists and reflects the new topic (not the original)
9. Verify `ui:report` client event received

**Features exercised:** Real Claude SDK call with interrupt, held state, write-to-redirect pattern clearing held flag, agent re-invocation after interrupt with different context, sequence `completedMap` preservation (set-topic cached, not re-executed), dynamic prompt function reading current blackboard state, `blackboardNamespace` scoping, `emitToClient` after redirect.

**Test considerations:** Long timeout (90s+) to account for API latency. The "reflects the new topic" assertion should check that `researcher:research:output.summary` or `keyFindings` contains terms related to "game AI" rather than "robotics" — a loose semantic check, not exact string matching.

---

## Scope

This spec covers:
1. Bridging `client:event` from the tree event emitter to the SSE stream in `ActorServer`/`TreeActor` (prerequisite framework change).
2. The 7 test files and their tree designs.

Each test is independent and can be implemented in any order after the prerequisite is in place. No changes to the test harness or existing tests.

## File Layout

```
src/__integration__/
  multi-step-action-workflow.test.ts
  interrupt-redirect-resume.test.ts
  parallel-approval-policy.test.ts
  selector-preemption-reactive.test.ts
  client-event-driven-wizard.test.ts
  live/
    agent-structured-pipeline.test.ts
    agent-interrupt-and-redirect.test.ts
```

## Conventions

- One test per file, named after the functionality being verified
- Each test uses `await using harness = await setupTest(...)` for setup/teardown
- Deterministic tests use mock actions (sync or async with short delays)
- Live tests require `ANTHROPIC_API_KEY` and use longer timeouts (90s)
- Assertions focus on the anchored integration point but also verify key supporting behaviors
