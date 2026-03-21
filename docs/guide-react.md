# React Integration

`@cartographer/react` provides React hooks for the Cartographer client SDK. It connects your React components to a running `ActorServer` via hooks backed by `useSyncExternalStore`, giving you live blackboard data, tree status, connection state, and action dispatching with zero manual event wiring.

This guide assumes you have a Cartographer `ActorServer` running. If you haven't set one up yet, read the [Application Server](guide-app-server.md) guide first.

---

## Prerequisites

- React >= 18
- A running Cartographer `ActorServer`

## Installation

```bash
npm install @cartographer/react @cartographer/client
```

`@cartographer/client` is a peer dependency — it provides the underlying `CartographerClient` that the React hooks wrap.

---

## The `<CartographerProvider>` Provider

Every `@cartographer/react` hook reads from React context, so your component tree needs a `<CartographerProvider>` at the top. The provider creates a client, opens an SSE connection on mount, and disconnects on unmount.

```tsx
// src/App.tsx
import { CartographerProvider } from "@cartographer/react";
import { Dashboard } from "./Dashboard";

export function App() {
  return (
    <CartographerProvider url="http://localhost:3148">
      <Dashboard />
    </CartographerProvider>
  );
}
```

### Props

| Prop       | Type                 | Description                                                                                                  |
| ---------- | -------------------- | ------------------------------------------------------------------------------------------------------------ |
| `url`      | `string`             | Base URL of the `ActorServer`. A `CartographerClient` is created automatically.                              |
| `client`   | `CartographerClient` | Bring-your-own client instance. When provided, `url` is ignored. Useful for testing or custom configuration. |
| `children` | `ReactNode`          | Standard React children.                                                                                     |

You must provide either `url` or `client`. The provider calls `client.connect()` on mount and `client.disconnect()` on unmount, so you do not need to manage the SSE lifecycle yourself.

---

## Reading Blackboard State

The blackboard is the shared key-value store that your behavior tree reads and writes. `@cartographer/react` offers two hooks depending on whether you need a single key or the full object.

### `useBlackboard<T>(key)`

Returns a `[value, setter]` tuple for a single blackboard key. The value updates whenever the server sends a `blackboard:write` event for that key.

```tsx
import { useBlackboard } from "@cartographer/react";

function Greeting() {
  const [greeting] = useBlackboard<string>("greeting");

  return <p>Current greeting: {greeting ?? "none"}</p>;
}
```

The returned tuple has two members:

| Index        | Type                          | Description                                                                                                                                    |
| ------------ | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `[0]` value  | `T \| undefined`              | The current value for the key. `undefined` if the key hasn't been written.                                                                     |
| `[1]` setter | `(value: T) => Promise<void>` | Writes the value to the server via HTTP. Not an optimistic update — the value changes only after the server echoes the write back through SSE. |

Writing a value from a component:

```tsx
import { useBlackboard } from "@cartographer/react";

function ThemeToggle() {
  const [theme, setTheme] = useBlackboard<string>("config:theme");

  async function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    await setTheme(next);
  }

  return <button onClick={toggleTheme}>Theme: {theme ?? "loading..."}</button>;
}
```

### `useBlackboardSnapshot()`

Returns the entire blackboard as a `Record<string, unknown>`. The object updates on every key change and on full snapshot events (e.g., on initial connection).

```tsx
import { useBlackboardSnapshot } from "@cartographer/react";

function DebugPanel() {
  const board = useBlackboardSnapshot();

  return <pre>{JSON.stringify(board, null, 2)}</pre>;
}
```

Prefer `useBlackboard` when you only need one or two keys. `useBlackboardSnapshot` triggers a re-render on any blackboard change, which is useful for debug panels but wasteful for targeted UI.

---

## Connection and Tree Status

### `useConnectionStatus()`

Returns the SSE connection status directly.

```tsx
import { useConnectionStatus } from "@cartographer/react";

function ConnectionBadge() {
  const status = useConnectionStatus();

  if (status === "connected") return <span>Connected</span>;
  if (status === "connecting") return <span>Reconnecting...</span>;
  return <span>Disconnected</span>;
}
```

The value is one of `'connecting'`, `'connected'`, or `'disconnected'`. It starts as `'connecting'` and transitions to `'connected'` when the first `snapshot` SSE event arrives.

### `useTreeStatus()`

Returns the most recent tree tick result, or `null` if no tick has been received yet.

```tsx
import { useTreeStatus } from "@cartographer/react";

function TreeInfo() {
  const tree = useTreeStatus();

  if (!tree) return <p>Waiting for first tick...</p>;

  return (
    <div>
      <p>Status: {tree.status}</p>
      <p>Duration: {tree.durationMs}ms</p>
      <p>Ticks observed: {tree.localTickCount}</p>
    </div>
  );
}
```

The value is `null` until the first `tree:tick` SSE event arrives, and resets to `null` on reconnection (when a new snapshot is received). The `TreeStatusInfo` object contains:

| Field            | Type     | Description                                                                            |
| ---------------- | -------- | -------------------------------------------------------------------------------------- |
| `status`         | `string` | Node status from the root tick — typically `"success"`, `"failure"`, or `"running"`.   |
| `durationMs`     | `number` | Wall-clock duration of the tick in milliseconds.                                       |
| `localTickCount` | `number` | Client-side tick counter, incremented on every `tree:tick` event. Resets on reconnect. |

---

## Dispatching Actions

`useAction` returns a handle for sending named actions to the server. It tracks whether the action is still in flight or awaiting server-side completion.

```tsx
import { useAction } from "@cartographer/react";

function ApproveButton() {
  const approve = useAction("approve");

  return (
    <button onClick={() => approve.send({ comment: "Ship it" })} disabled={approve.pending}>
      {approve.pending ? "Sending..." : "Approve"}
    </button>
  );
}
```

The returned object has three members:

| Member                  | Type                                               | Description                                                                                                                                                |
| ----------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pending`               | `boolean`                                          | `true` while an HTTP request is in flight or a dispatched message hasn't received its `message:processed` / `message:failed` SSE event.                    |
| `send(payload?)`        | `(unknown?) => Promise<{ id }>`                    | Fires the action and returns the server-assigned message ID. `pending` remains `true` until the SSE settlement event arrives.                              |
| `sendAndWait(payload?)` | `(unknown?) => Promise<{ messageId, treeStatus }>` | Fires the action and waits for the server to finish processing. The promise resolves with the final tree status, or rejects if the server reports failure. |

### Fire-and-forget vs. await completion

Use `send` when the UI should update optimistically — the button disables via `pending` and re-enables when the server confirms completion through SSE.

Use `sendAndWait` when subsequent logic depends on the tree run finishing:

```tsx
import { useState } from "react";
import { useAction } from "@cartographer/react";

function AnalysisPanel() {
  const analyze = useAction("analyze");
  const [result, setResult] = useState<string | null>(null);

  async function runAnalysis() {
    const { treeStatus } = await analyze.sendAndWait({ document: "some-doc-id" });
    setResult(treeStatus);
  }

  return (
    <div>
      <button onClick={runAnalysis} disabled={analyze.pending}>
        Analyze
      </button>
      {result && <p>Tree finished with status: {result}</p>}
    </div>
  );
}
```

### Lifecycle

`useAction` registers `message:processed` and `message:failed` SSE listeners on mount and removes them on unmount. If the component unmounts while a `sendAndWait` promise is pending, the promise rejects with a `"Component unmounted"` error.

---

## Listening to Events

### `useClientEvent(name, handler)`

Subscribes to events emitted by `emitToClient` nodes on the server. The event name must match the name used in the server-side tree.

```tsx
import { useState } from "react";
import { useClientEvent } from "@cartographer/react";

function ReviewFindings() {
  const [findings, setFindings] = useState<unknown>(null);

  useClientEvent("ui:show_review", (data) => {
    setFindings(data);
  });

  if (!findings) return null;
  return <pre>{JSON.stringify(findings, null, 2)}</pre>;
}
```

### `useTreeEvent(type, handler)`

Subscribes to raw SSE event types like `node:enter`, `node:exit`, or `tree:tick`. Use this for low-level tree lifecycle events not covered by the higher-level hooks.

```tsx
import { useState } from "react";
import { useTreeEvent } from "@cartographer/react";

function TickLog() {
  const [tickLog, setTickLog] = useState<string[]>([]);

  useTreeEvent("tree:tick", (data) => {
    const d = data as { status: string };
    setTickLog((prev) => [...prev, d.status]);
  });

  return (
    <ul>
      {tickLog.map((entry, i) => (
        <li key={i}>{entry}</li>
      ))}
    </ul>
  );
}
```

Both hooks register their listener on mount and clean up on unmount. The handler ref is kept up-to-date across re-renders, so the latest closure is always called without re-subscribing to the client.

---

## Direct Client Access

When the hooks don't cover the operation you need, use `useClient()` to access the underlying `CartographerClient` directly.

```tsx
import { useClient } from "@cartographer/react";

function RedirectButton() {
  const client = useClient();

  async function interruptAndRedirect() {
    await client.interrupt();
    await client.action("redirect", { target: "/new-path" });
  }

  return <button onClick={interruptAndRedirect}>Redirect</button>;
}
```

`useClient()` must be called inside a `<CartographerProvider>`. It returns the same `CartographerClient` instance documented in the [Client SDK](guide-app-server.md#client-sdk) section of the Application Server guide.

---

## Full Example

This example ties together a provider, blackboard reading, action dispatching, and client event handling into a minimal review approval flow.

```tsx
// src/App.tsx
import { CartographerProvider } from "@cartographer/react";
import { ReviewPanel } from "./ReviewPanel";

export function App() {
  return (
    <CartographerProvider url="http://localhost:3148">
      <ReviewPanel />
    </CartographerProvider>
  );
}
```

```tsx
// src/ReviewPanel.tsx
import { useState } from "react";
import { useBlackboard, useConnectionStatus, useTreeStatus, useAction, useClientEvent } from "@cartographer/react";

export function ReviewPanel() {
  const status = useConnectionStatus();
  const tree = useTreeStatus();
  const [analysis] = useBlackboard<{ summary: string }>("analysis");
  const approve = useAction("approve");
  const reject = useAction("reject");

  const [findings, setFindings] = useState<unknown>(null);

  useClientEvent("ui:show_review", (data) => {
    setFindings(data);
  });

  if (status !== "connected") {
    return <p>Connecting to server...</p>;
  }

  return (
    <div>
      <h2>Review Panel</h2>

      {findings && (
        <section>
          <h3>Findings</h3>
          <pre>{JSON.stringify(findings, null, 2)}</pre>
        </section>
      )}

      {analysis && <p>Analysis: {analysis.summary}</p>}

      <div>
        <button onClick={() => approve.send()} disabled={approve.pending}>
          {approve.pending ? "Approving..." : "Approve"}
        </button>
        <button onClick={() => reject.send()} disabled={reject.pending}>
          {reject.pending ? "Rejecting..." : "Reject"}
        </button>
      </div>

      {tree && (
        <footer>
          Last tick: {tree.status} ({tree.durationMs}ms)
        </footer>
      )}
    </div>
  );
}
```

---

## Testing

`@cartographer/react` exports a `createMockClient()` utility that lets you test components without a running server.

### `createMockClient()`

Creates a mock `CartographerClient` with all methods stubbed via `vi.fn()`. The mock includes an `emit(event, data)` helper that dispatches synthetic SSE events to registered handlers. Requires `vitest` in your test environment.

```typescript
import { createMockClient } from "@cartographer/react";

const client = createMockClient();

// Simulate a server snapshot
client.emit("snapshot", { blackboard: { greeting: "hello" } });

// Assert that action was called
await client.action("approve", { comment: "LGTM" });
expect(client.action).toHaveBeenCalledWith("approve", { comment: "LGTM" });
```

### Provider wrapper

Wrap your `renderHook` and `render` calls with a `<CartographerProvider>` that receives the mock client:

```tsx
import React from "react";
import { CartographerProvider, createMockClient } from "@cartographer/react";

function wrapper(client: ReturnType<typeof createMockClient>) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <CartographerProvider client={client}>{children}</CartographerProvider>;
  };
}
```

### Testing hooks

Use `renderHook` from `@testing-library/react` with the wrapper:

```typescript
import { renderHook, act } from "@testing-library/react";
import { useBlackboard } from "@cartographer/react";

const client = createMockClient();
const { result } = renderHook(() => useBlackboard<string>("name"), {
  wrapper: wrapper(client),
});

// Before any server events
expect(result.current[0]).toBeUndefined();

// Simulate a server snapshot
act(() => client.emit("snapshot", { blackboard: { name: "Alice" } }));
expect(result.current[0]).toBe("Alice");
```

### Testing components

The same wrapper pattern works with `render`:

```tsx
import { render } from "@testing-library/react";

const client = createMockClient();
const Wrapper = wrapper(client);

const { getByText } = render(
  <Wrapper>
    <ReviewPanel />
  </Wrapper>,
);

// Simulate connection and assert against rendered output
act(() => client.emit("snapshot", { blackboard: { analysis: { summary: "All clear" } } }));
expect(getByText("Analysis: All clear")).toBeDefined();
```

---

## API at a Glance

| Export                          | Kind         | Description                                                             |
| ------------------------------- | ------------ | ----------------------------------------------------------------------- |
| `CartographerProvider`          | Component    | Provider that manages client lifecycle and context.                     |
| `useClient()`                   | Hook         | Returns the raw `CartographerClient` from context.                      |
| `useBlackboard<T>(key)`         | Hook         | `[value, setter]` tuple for a single blackboard key.                    |
| `useBlackboardSnapshot()`       | Hook         | Full blackboard as `Record<string, unknown>`.                           |
| `useConnectionStatus()`         | Hook         | SSE connection state (`'connecting'`, `'connected'`, `'disconnected'`). |
| `useTreeStatus()`               | Hook         | Latest tree tick result, or `null`.                                     |
| `useAction(name)`               | Hook         | Action handle with `send`, `sendAndWait`, and `pending`.                |
| `useClientEvent(name, handler)` | Hook         | Subscribe to `emitToClient` events.                                     |
| `useTreeEvent(type, handler)`   | Hook         | Subscribe to raw SSE event types.                                       |
| `createMockClient()`            | Test utility | Mock client with `emit()` for simulating SSE events.                    |
| `TreeStatusInfo`                | Type         | Shape of the tree status object.                                        |
| `ConnectionStatus`              | Type         | `'connecting' \| 'connected' \| 'disconnected'`.                        |

All hooks must be called inside a `<CartographerProvider>`.

---

## Where to Go Next

- [Application Server](guide-app-server.md) -- server-side setup, endpoints, and the processing model.
- [Client SDK API](api/client.md) -- full reference for `CartographerClient` methods.
- [Blackboard and Events](guide-blackboard-and-events.md) -- how blackboard state and events work at the tree level.
- [Testing Behavior Trees](guide-testing.md) -- patterns for testing the server-side trees your React app connects to.
