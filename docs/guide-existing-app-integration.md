# Integrating Cartographer into an Existing App

This guide walks through adding Cartographer to a typical production stack: an Express server, React frontend with Zustand, and Postgres database. By the end you'll have a working human-in-the-loop workflow where an AI agent drafts support ticket responses, a human reviewer approves or redirects them, and your existing app remains the source of truth.

The domain is a **support ticket resolution platform** — an internal tool where support agents manage customer tickets. Cartographer handles the AI-assisted drafting and review workflow; your existing app handles everything else (ticket CRUD, assignment, auth, billing).

---

## What Cartographer adds to your app

Without Cartographer, wiring an AI agent into a ticket workflow looks something like this: an API route calls Claude, saves the result, and the frontend polls for updates. Simple enough for one step. But real workflows have multiple steps, branching, retries, human review gates, and long-running agent calls that outlive a single HTTP request. You end up building a state machine, a persistence layer, a retry system, and a real-time notification mechanism — or you reach for a workflow engine.

Cartographer is a behavior tree framework that gives you all of that with a programming model instead of a configuration DSL:

- **Structured control flow** — Sequences, selectors, retries, timeouts, and guards compose into readable trees. The happy path and every error path are visible in one place.
- **Suspension and resumption** — When the tree needs human input, it suspends. State is serialized. When the human responds (minutes or days later), the tree resumes exactly where it left off.
- **Real-time observability** — Every node transition, agent prompt, and tool call is streamed to connected clients via SSE. Your React UI can show the agent's progress live.
- **Crash recovery** — Tree state is persisted after every message. Deploys, restarts, and crashes don't lose progress.

---

## Architecture

Cartographer does not replace your server or database. It mounts alongside your existing Express routes and connects to your existing Postgres through action nodes that call your data layer.

```
┌─────────────────────────────────────────────────────┐
│  Express Server                                      │
│                                                      │
│  /api/tickets/*        → your existing routes        │
│  /api/auth/*           → your existing routes        │
│  /cartographer/*       → Cartographer (Hono app)     │
│                                                      │
│  ┌──────────────────────────────────────────────┐    │
│  │  Cartographer AppHandle                       │    │
│  │                                               │    │
│  │  Behavior Tree (per message):                 │    │
│  │    1. Load ticket from Postgres               │    │
│  │    2. Agent drafts response                   │    │
│  │    3. Notify UI → suspend for review          │    │
│  │    4. On approve → save to Postgres → notify  │    │
│  │                                               │    │
│  │  State: Redis or InMemoryStateStore           │    │
│  └──────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│  React Frontend                                      │
│                                                      │
│  Zustand stores      → tickets, auth, UI state       │
│  Cartographer hooks  → draft status, agent activity  │
│                                                      │
│  CartographerProvider wraps only the review panel,   │
│  not the entire app.                                 │
└─────────────────────────────────────────────────────┘
```

Your Postgres remains the source of truth for tickets. Cartographer's blackboard holds transient workflow state — the draft, the agent's analysis, review feedback. When the workflow completes, an action node writes the final result back to Postgres through your existing data layer.

---

## Installation

```bash
npm install cartographer @cartographer/react @cartographer/client
```

---

## Server Side

### Mounting into Express

Use `createApp` to get a Cartographer `AppHandle`, then mount it into your existing Express app with `nodeHandler()`.

```typescript
// src/server/cartographer.ts
import { createApp } from "cartographer";
import { RedisStateStore } from "cartographer";
import Redis from "ioredis";
import { createReviewTree } from "./trees/ticket-review.js";
import { getUserId } from "./auth.js"; // your existing auth helper

const redis = new Redis(process.env.REDIS_URL!);

export const cartographer = createApp({
  createTree: () => createReviewTree(),
  stateStore: new RedisStateStore({ redis, keyPrefix: "carto:" }),
  sessionId: (c) => {
    // Extract user ID from your existing auth — cookie, JWT, session, etc.
    // Each support agent gets their own session.
    const token = c.req.header("authorization")?.replace("Bearer ", "");
    return getUserId(token);
  },
  topologyPolicy: "reset", // safe for development; use 'fail' in production
});
```

```typescript
// src/server/app.ts — your existing Express app
import express from "express";
import { ticketRouter } from "./routes/tickets.js";
import { authRouter } from "./routes/auth.js";
import { cartographer } from "./cartographer.js";

const app = express();

// Your existing routes
app.use("/api/tickets", ticketRouter);
app.use("/api/auth", authRouter);

// Mount Cartographer
app.use("/cartographer", cartographer.nodeHandler());

await cartographer.start();
app.listen(3000);
```

That's it for the server plumbing. Cartographer's routes (`/cartographer/api/messages`, `/cartographer/events`, etc.) are now live alongside your existing API. Your auth middleware determines the session — each support agent's workflow state is isolated.

### Building the review tree

The tree defines the workflow: load the ticket, draft a response, wait for human review, then act on the decision.

```typescript
// src/server/trees/ticket-review.ts
import {
  BehaviorTree,
  SequenceNode,
  SelectorNode,
  ActionNode,
  AgentNode,
  ClaudeSDKAgent,
  NodeStatus,
  notify,
  receive,
  untilSuccess,
} from "cartographer";
import { z } from "zod/v4";
import { db } from "../db.js"; // your existing Postgres client (Drizzle, Prisma, Knex, etc.)

// --- Agents ---

const draftAgent = new ClaudeSDKAgent({
  name: "draft-response",
  model: "claude-sonnet-4-6",
  systemPrompt: `You are a senior support agent. Draft a professional, empathetic
response to the customer's ticket. Be specific to their issue — do not use
generic templates. Keep it under 200 words.`,
});

const reviseAgent = new ClaudeSDKAgent({
  name: "revise-response",
  model: "claude-sonnet-4-6",
  systemPrompt: `You are a senior support agent. Revise the draft response based on
the reviewer's feedback. Preserve the original tone unless the feedback says otherwise.`,
});

// --- Tree ---

export function createReviewTree() {
  return new BehaviorTree({
    name: "ticket-review",
    root: new SequenceNode({
      name: "main",
      children: [
        // Step 1: Load ticket data from Postgres into the blackboard
        loadTicket(),

        // Step 2: Agent drafts a response
        new AgentNode<unknown>({
          name: "draft",
          agent: draftAgent,
          prompt: (ctx) => {
            const ticket = ctx.blackboard.get<Ticket>("ticket");
            return `Draft a response to this support ticket.

Subject: ${ticket!.subject}
Customer: ${ticket!.customerName}
Message: ${ticket!.body}
Category: ${ticket!.category}
Priority: ${ticket!.priority}`;
          },
        }),

        // Step 3: Notify the UI that a draft is ready, then suspend
        notify("review:draft-ready", (ctx) => ({
          draft: ctx.blackboard.get("draft:output"),
          ticket: ctx.blackboard.get("ticket"),
        })),
        waitForReviewDecision(),

        // Step 4: Handle the decision
        new SelectorNode({
          name: "handle-decision",
          children: [
            approveAndSend(),
            reviseAndLoop(),
          ],
        }),
      ],
    }),
  });
}
```

Each piece below is a function that returns a node or subtree. This keeps the top-level tree readable while the implementation details stay close to their concerns.

### Loading data from Postgres

Action nodes bridge Cartographer and your existing data layer. The tree doesn't know about Postgres — it calls your app's functions and writes results to the blackboard.

```typescript
function loadTicket() {
  return new ActionNode({
    name: "load-ticket",
    action: async (ctx) => {
      const ticketId = ctx.blackboard.get<string>("ticketId");
      if (!ticketId) return NodeStatus.FAILURE;

      const ticket = await db.tickets.findById(ticketId);
      if (!ticket) return NodeStatus.FAILURE;

      ctx.blackboard.set("ticket", ticket);

      // Load recent conversation history for context
      const history = await db.messages.findByTicketId(ticketId, { limit: 10 });
      ctx.blackboard.set("ticket:history", history);

      return NodeStatus.SUCCESS;
    },
  });
}
```

### Suspension points: waiting for human input

`untilSuccess` wraps a selector that checks for any of the possible user actions. If none have arrived, the selector fails, `untilSuccess` converts that to `RUNNING`, and the tree suspends. State is serialized. When the user eventually sends a command, the tree resumes and the selector finds the matching `receive` node.

```typescript
function waitForReviewDecision() {
  return untilSuccess(
    new SelectorNode({
      name: "await-review",
      children: [
        receive("approve"),
        receive<{ feedback: string }>("request-revision", {
          mapPayload: (payload, bb) => {
            bb.set("revision:feedback", payload.feedback);
          },
        }),
        receive("reject"),
      ],
    }),
  );
}
```

The tree will sit in this suspended state for as long as it takes — seconds, hours, or days. Redis-backed state means it survives deploys. When the support agent clicks "Approve" in the React UI, the client sends a `command("approve")`, the tree wakes up, and execution continues with the next node in the sequence.

### Acting on the decision

```typescript
function approveAndSend() {
  return new SequenceNode({
    name: "approve-path",
    children: [
      new ConditionNode({
        name: "was-approved",
        condition: (ctx) => ctx.blackboard.get("commands:approve") !== undefined
          || ctx.blackboard.get("approve:received") === true,
      }),

      // Write the approved response back to Postgres
      new ActionNode({
        name: "send-response",
        action: async (ctx) => {
          const ticketId = ctx.blackboard.get<string>("ticketId");
          const draft = ctx.blackboard.get<string>("draft:output");
          await db.messages.create({
            ticketId: ticketId!,
            body: draft!,
            sender: "agent",
          });
          await db.tickets.updateStatus(ticketId!, "responded");
          return NodeStatus.SUCCESS;
        },
      }),

      // Notify the UI that the response was sent
      notify("review:complete", (ctx) => ({
        ticketId: ctx.blackboard.get("ticketId"),
        status: "sent",
      })),
    ],
  });
}

function reviseAndLoop() {
  return new SequenceNode({
    name: "revision-path",
    children: [
      new ConditionNode({
        name: "revision-requested",
        condition: (ctx) => ctx.blackboard.has("revision:feedback"),
      }),

      // Agent revises based on reviewer feedback
      new AgentNode<unknown>({
        name: "revise",
        agent: reviseAgent,
        prompt: (ctx) => {
          const draft = ctx.blackboard.get<string>("draft:output");
          const feedback = ctx.blackboard.get<string>("revision:feedback");
          return `Here is the current draft response:

${draft}

The reviewer provided this feedback:

${feedback}

Please revise the draft accordingly.`;
        },
      }),

      // Clear the feedback so the next review cycle starts clean
      new ActionNode({
        name: "clear-feedback",
        action: (ctx) => {
          ctx.blackboard.delete("revision:feedback");
          return NodeStatus.SUCCESS;
        },
      }),

      // Notify UI with the revised draft, suspend again for review
      notify("review:draft-ready", (ctx) => ({
        draft: ctx.blackboard.get("revise:output"),
        ticket: ctx.blackboard.get("ticket"),
        revised: true,
      })),
      waitForReviewDecision(),
    ],
  });
}
```

The revision path loops naturally: the agent revises, notifies the UI, and suspends again for review. Each revision cycle is a full round trip through the tree's suspension mechanism — serialized to Redis, resumed on the next command.

### Starting a workflow

Your existing ticket API starts the Cartographer workflow by writing the ticket ID to the blackboard and sending a tick:

```typescript
// src/server/routes/tickets.ts — your existing ticket router
import { cartographer } from "../cartographer.js";

ticketRouter.post("/:id/review", async (req, res) => {
  // Write the ticket ID to the blackboard, then tick the tree
  await cartographer.processMessage(
    { type: "write", key: "ticketId", value: req.params.id },
    req.params.id, // session key for this specific ticket
  );
  await cartographer.processMessage(
    { type: "tick" },
    req.params.id,
  );

  res.json({ status: "started" });
});
```

---

## React Side

### Cartographer alongside Zustand

Cartographer hooks and Zustand stores serve different purposes and coexist without conflict. Zustand owns your app state — ticket lists, filters, user preferences, auth. Cartographer hooks own the live workflow state — the current draft, agent progress, review status.

The `CartographerProvider` does not need to wrap your entire app. Mount it around the component subtree that participates in the review workflow:

```tsx
// src/components/TicketDetail.tsx
import { CartographerProvider } from "@cartographer/react";
import { useTicketStore } from "../stores/tickets"; // your Zustand store
import { ReviewWorkflow } from "./ReviewWorkflow";

export function TicketDetail({ ticketId }: { ticketId: string }) {
  // Zustand: ticket data, assignment, status
  const ticket = useTicketStore((s) => s.tickets[ticketId]);

  return (
    <div>
      <header>
        <h1>{ticket.subject}</h1>
        <span>{ticket.status}</span>
      </header>

      <MessageHistory ticketId={ticketId} />

      {ticket.status === "reviewing" && (
        <CartographerProvider url="/cartographer">
          <ReviewWorkflow ticketId={ticketId} />
        </CartographerProvider>
      )}
    </div>
  );
}
```

The provider connects to Cartographer's SSE stream on mount and disconnects on unmount. When the ticket leaves the "reviewing" state, the provider unmounts and the connection closes. No background resource consumption for tickets that aren't actively being reviewed.

### The review workflow component

This component uses Cartographer hooks for real-time workflow state and Zustand for ticket metadata. They don't interfere with each other.

```tsx
// src/components/ReviewWorkflow.tsx
import { useState } from "react";
import {
  useBlackboard,
  useCommand,
  useConnectionStatus,
  useClientEvent,
} from "@cartographer/react";
import { useTicketStore } from "../stores/tickets";

export function ReviewWorkflow({ ticketId }: { ticketId: string }) {
  const connection = useConnectionStatus();
  const approve = useCommand("approve");
  const reject = useCommand("reject");
  const requestRevision = useCommand<{ feedback: string }>("request-revision");

  // Cartographer: live draft from the blackboard
  const [draft] = useBlackboard<string>("draft:output");

  // Local state for the feedback form
  const [feedback, setFeedback] = useState("");
  const [completed, setCompleted] = useState(false);

  // Listen for the tree's completion notification
  useClientEvent("review:complete", (data) => {
    setCompleted(true);
    // Update your Zustand store with the new ticket status
    useTicketStore.getState().updateStatus(ticketId, "responded");
  });

  if (connection !== "connected") {
    return <p>Connecting to review workflow...</p>;
  }

  if (completed) {
    return <p>Response sent to customer.</p>;
  }

  if (!draft) {
    return <AgentProgress />;
  }

  return (
    <div>
      <h3>Draft Response</h3>
      <div className="draft-preview">{draft}</div>

      <div className="review-actions">
        <button
          onClick={() => approve.send()}
          disabled={approve.pending}
        >
          {approve.pending ? "Sending..." : "Approve & Send"}
        </button>

        <button
          onClick={() => reject.send()}
          disabled={reject.pending}
        >
          Reject
        </button>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            requestRevision.send({ feedback });
            setFeedback("");
          }}
        >
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="Revision feedback..."
          />
          <button
            type="submit"
            disabled={requestRevision.pending || !feedback.trim()}
          >
            Request Revision
          </button>
        </form>
      </div>
    </div>
  );
}
```

### Watching agent progress

While the agent is drafting, you can show live progress using `useTreeEvent`. Every agent prompt, tool call, and text chunk is streamed via SSE:

```tsx
// src/components/AgentProgress.tsx
import { useState } from "react";
import { useTreeEvent } from "@cartographer/react";

export function AgentProgress() {
  const [status, setStatus] = useState("Starting...");

  useTreeEvent("agent:text", (data) => {
    const d = data as { nodeName: string; text: string };
    setStatus(`Drafting: ${d.text.slice(0, 100)}...`);
  });

  useTreeEvent("agent:tool_use", (data) => {
    const d = data as { nodeName: string; toolName: string };
    setStatus(`Using tool: ${d.toolName}`);
  });

  return (
    <div className="agent-progress">
      <span className="spinner" />
      <p>{status}</p>
    </div>
  );
}
```

### Interrupting a long-running agent

If the support agent realizes the ticket was miscategorized while the AI is still drafting, they can interrupt mid-generation:

```tsx
import { useClient } from "@cartographer/react";

function InterruptButton() {
  const client = useClient();

  async function handleInterrupt() {
    const { interrupted } = await client.interrupt();
    if (interrupted) {
      // Redirect the agent with new context
      await client.write("ticket:context", "Customer clarified: this is a billing issue, not technical.");
    }
  }

  return <button onClick={handleInterrupt}>Redirect Agent</button>;
}
```

After interruption, the tree enters a held state. The next `command` or `write` clears the held state and resumes processing with the updated context.

---

## What this enables

The integration above is roughly 200 lines of tree definition and 100 lines of React components. Here's what you get from that:

**Workflows that survive anything.** The tree's state is serialized to Redis after every step. Deploy your app, restart the server, crash and recover — the review workflow picks up exactly where it left off. A support agent can start a review on Monday and approve the draft on Wednesday.

**Visible agent behavior.** The `useTreeEvent` hook gives you a live view into what the agent is doing — which tool it's calling, what it's generating, how long it's taking. No more "the AI is thinking" black boxes. You can build progress indicators, audit logs, or dashboards without any custom plumbing.

**Structured human-in-the-loop.** The `untilSuccess(selector([receive("approve"), receive("reject"), ...]))` pattern creates clean suspension points where the tree waits for human judgment. The tree doesn't poll, spin, or waste resources while waiting — it serializes its state and stops. When the human acts, it resumes.

**Retry and error isolation.** Wrap any agent call in `retry` or `timeout` decorators. If the agent fails, the tree follows the retry policy or falls back to an alternative branch — without you writing retry logic or error state machines.

**Separation between workflow and data.** Postgres is still your source of truth. Cartographer's blackboard holds transient workflow state. Action nodes bridge the two: they read from your database at the start and write back at the end. If you ever remove Cartographer, your data model doesn't change.

### Other workflows this pattern supports

The same integration pattern — mount the Hono app, define a tree, use React hooks — applies to any workflow with human decision points and AI assistance:

- **Document review** — Agent analyzes a document for compliance issues, flags sections, human reviewer approves or requests changes.
- **Content moderation** — Agent classifies and scores user-generated content, borderline cases are routed to human moderators.
- **Onboarding flows** — Agent personalizes setup recommendations, account manager reviews before provisioning.
- **Approval chains** — Multi-level approval workflows where agents prepare summaries and humans make decisions at each gate.
- **Incident response** — Agent diagnoses an alert, drafts a mitigation plan, on-call engineer reviews and executes.

In each case, the behavior tree gives you the control flow, Cartographer gives you the persistence and real-time delivery, and your existing app stays in charge of the data.

---

## Where to go next

- [Application Server](guide-app-server.md) — Full reference for `createApp`, `ActorServer`, `StateStore`, and the client SDK.
- [Agent Integration](guide-agent-integration.md) — Agent configuration, structured output, MCP tools, and shared sessions.
- [React Integration](guide-react.md) — Complete hook reference for `@cartographer/react`.
- [Nodes](guide-nodes.md) — All leaf node types including `receive` and `notify`.
- [Decorators](guide-decorators.md) — Retry, timeout, guard, and other control flow decorators.
- [Error Handling](guide-error-handling.md) — Abort, interrupt, and recovery patterns.
