# Server Split: TreeServer + Dashboard Static Server

## Problem

The `TreeServer` was recently renamed from `DashboardServer` to make it general-purpose, but it still contains dashboard-specific concerns: static file serving from `dist/dashboard/`, a hardcoded event exclusion list, and a manually maintained event name array. These need to be separated so the TreeServer is a clean API/SSE server and the dashboard is a fully independent application that happens to consume it.

## Design

### Two independent servers

**TreeServer** (`src/server/tree-server.ts`) is a pure API + SSE server. It exposes REST endpoints for tree state and an SSE stream of all tree events. It has no knowledge of any frontend application.

**Dashboard server** (`dashboard/src/server.ts`) is a static file server with an API proxy. It lives inside the dashboard application, serves the built Svelte app from `dist/dashboard/`, and proxies `/api/*` and `/events` requests to the TreeServer. It has no behavior-tree dependencies — only `node:http`, `node:fs`, and `node:path`. The dashboard frontend keeps using same-origin URLs unchanged.

The CLI starts both servers on separate ports. They are fully decoupled — the dashboard server proxies API traffic to the TreeServer, so the browser never makes cross-origin requests.

### TreeServer changes

**Remove static file serving.** Delete `serveStaticFile`, the `CONTENT_TYPES` map, and the `fs`/`path` imports. Non-API, non-SSE requests return a 404.

**Remove `EXCLUDED_EVENTS`.** The server broadcasts every event to every SSE client. Filtering is the client's responsibility. The dashboard client already only subscribes to events it cares about via named `EventSource` listeners — unhandled events like `agent:stream` are silently ignored by the browser's `EventSource` API.

**Dynamic event subscription.** Replace the hardcoded event name array with an `onAny` method on the `EventEmitter`. The TreeServer subscribes once with `onAny` and forwards all events through the serializer, buffer, and SSE broadcast pipeline. This means new events added to `TreeEvents` are automatically broadcast without any server-side code changes.

The `onAny` method signature:

```ts
onAny(listener: (event: string, data: unknown) => void): void;
offAny(listener: (event: string, data: unknown) => void): void;
```

These are added to both the `TypedEventEmitter` interface and the `EventEmitter` class. The `emit` method calls any-listeners after per-event listeners, passing `(event, data)`.

**No CORS needed.** The dashboard server proxies API requests to the TreeServer, so the browser only ever talks to the dashboard's origin. No cross-origin requests, no CORS headers required on the TreeServer.

### `http-utils.ts` extraction

Extract `jsonResponse` and `jsonError` from `tree-server.ts` into `src/server/http-utils.ts`. Both `tree-server.ts` and `api-handlers.ts` import from this new module, eliminating the circular import between them.

### Dashboard server

A new file at `dashboard/src/server.ts`. This is a static file server with an API reverse proxy:

- Takes a static directory path, port, and TreeServer URL
- Serves static files with correct MIME types (the `CONTENT_TYPES` map moves here)
- Falls back to `index.html` for SPA routing (any path without a file extension serves `index.html`)
- Proxies `/api/*` and `/events` requests to the TreeServer URL using `node:http` request forwarding
- For SSE proxying (`/events`), pipes the response stream through without buffering
- Has no imports from the `src/` tree — it is completely independent

**Build integration.** The main `tsconfig.json` has `rootDir: "./src"`, so it cannot compile files in `dashboard/`. The dashboard server file is compiled separately: add a `dashboard/tsconfig.server.json` that compiles `dashboard/src/server.ts` to `dist/dashboard-server/server.js`. The `npm run build` script adds this compilation step after the existing Vite build.

**CLI import path.** The CLI imports the compiled dashboard server from the `dist/dashboard-server/server.js` output path using a dynamic import, similar to how it already dynamically imports user tree files in `run.ts`.

**No changes to `dashboard/src/lib/api.ts`.** The dashboard frontend continues to use `window.location.origin` as its base URL. All API and SSE requests hit the dashboard server's origin, which proxies them to the TreeServer.

### CLI changes

`src/cli/commands/run.ts` starts both servers:

- `TreeServer` on `--port` (default 3147)
- Dashboard server on `--dashboard-port` (default 3148)
- Terminal output shows both URLs
- `--no-serve` disables the TreeServer (and implicitly the dashboard, since it depends on the API)
- `--no-dashboard` disables only the dashboard server while keeping the TreeServer running

`--no-serve` retains its current meaning — it disables the API server. Since the dashboard is useless without the API, `--no-serve` implicitly disables it too. `--no-dashboard` is new and only disables the static file server.

### Exports

`src/index.ts` exports `TreeServer` and `TreeServerOptions`. The dashboard server is not part of the library's public API — it's an internal application concern.

## Files to create

| File | Purpose |
|------|---------|
| `src/server/http-utils.ts` | `jsonResponse`, `jsonError` helpers |
| `dashboard/src/server.ts` | Static file server for the Svelte app |
| `dashboard/tsconfig.server.json` | TypeScript config for compiling the dashboard server |

## Files to modify

| File | Change |
|------|--------|
| `src/server/tree-server.ts` | Remove static serving, remove `EXCLUDED_EVENTS`, use `onAny` |
| `src/server/api-handlers.ts` | Import from `http-utils.ts` instead of `tree-server.ts` |
| `src/core/event-emitter.ts` | Add `onAny`/`offAny` methods |
| `src/types.ts` | Add `onAny`/`offAny` to `TypedEventEmitter` interface |
| `src/cli/commands/run.ts` | Start both servers, show two URLs, handle `--no-dashboard` |
| `src/cli/parse-args.ts` | Add `--no-dashboard` and `--dashboard-port` flags, update help text |
| `src/index.ts` | No changes needed (already exports only `TreeServer`/`TreeServerOptions`) |
| `package.json` | Add dashboard server compilation to `build` script |

## Testing

- Existing `tree-server.test.ts` — update to verify 404 on non-API routes (instead of static file fallback)
- Existing integration tests (`rest-api.test.ts`, `sse-stream.test.ts`) — should pass unchanged since they only test API/SSE
- New unit test for `http-utils.ts`
- New unit test for `EventEmitter.onAny`/`offAny`
- New unit test for `dashboard/src/server.ts`
- Verify the SSE stream now includes all events (no exclusions)
- Verify the dashboard server proxies `/api/*` and `/events` to the TreeServer
- Verify SSE proxying streams without buffering
