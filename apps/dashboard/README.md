# Cartographer Dashboard

Real-time web UI for observing behavior tree execution. Displays tree structure, event stream, blackboard state, and node details as your tree runs.

## Quick Start

The dashboard starts automatically when you run a tree:

```bash
cartographer run my-tree.ts
# Actor server: http://localhost:3147
# Dashboard: http://localhost:3148
```

Open the Dashboard URL in your browser. The dashboard connects to the ActorServer API via a built-in reverse proxy and updates live as the tree ticks.

### Architecture

Two servers run independently:

- **ActorServer** (port 3147) — REST API and SSE event stream. This is the general-purpose API that any frontend can consume.
- **Dashboard server** (port 3148) — Serves the built Svelte app and proxies `/api/*` and `/events` requests to the ActorServer. The browser only talks to this origin.

### CLI Flags

| Flag | Description |
|------|-------------|
| `--port <number>` | Set the ActorServer API port (default: 3147) |
| `--dashboard-port <number>` | Set the dashboard port (default: 3148) |
| `--no-dashboard` | Disable the dashboard server |

## Panels

**Tree** (left) — Hierarchical view of the behavior tree. Each node shows its type icon, name, and a status indicator dot that updates in real time. Click a node to inspect it.

**Event Timeline** (center) — Chronological feed of all tree events: node enter/exit, agent activity, blackboard writes, strategy decisions. Filter by category using the chip bar at the top. When a node is selected, the timeline filters to show only events involving that node.

**Blackboard** (right) — Live key-value display of the tree's shared state. Keys are grouped by namespace (split on `:`). Recently updated keys flash briefly to indicate changes.

**Node Detail** (bottom drawer) — Appears when you click a node in the tree panel. Shows type, status, and node-specific metadata: model and tools for agent nodes, children count for composites, strategy info where applicable.

Both side panels are collapsible and resizable via drag handles. Below 900px viewport width, the layout switches to a tabbed mobile view.

## Development

```bash
pnpm --filter @cartographer/dashboard dev    # Vite dev server with hot reload
pnpm --filter @cartographer/dashboard build  # Production build to dist/dashboard/
```

The dev server proxies API requests to a running Cartographer instance, so start your tree in a separate terminal first.

### Tech Stack

- Svelte 5 (runes mode) + TypeScript
- Vite for bundling
- No runtime dependencies beyond Svelte

## HTTP API

The ActorServer exposes a REST + SSE API that the dashboard consumes via its reverse proxy. You can also use these endpoints directly for custom tooling by connecting to the ActorServer port.

### REST Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/tree` | Serialized tree structure |
| `GET /api/status` | Run stats: tick count, last status, duration, uptime |
| `GET /api/blackboard` | Current blackboard contents |
| `GET /api/nodes/:id` | Single node detail (includes model/tools for agents) |

### SSE Stream

`GET /events` — Server-Sent Events stream. On connect, the server sends a `snapshot` event with the full tree and blackboard state, then streams incremental events as they occur.

Supports `Last-Event-ID` for reconnection. If the requested ID has been evicted from the buffer, the server sends a fresh snapshot instead.

## Programmatic Usage

```ts
import { ActorServer } from 'cartographer';

const server = new ActorServer({
  createTree: () => myTreeFactory(),
  port: 3147,
});
const { port } = await server.start();

// ... tree accepts messages via HTTP ...

await server.stop();
```
