# Task 106: Add Lifecycle Event Types to Dashboard

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add ActorServer lifecycle event types (`message:processed`, `message:interrupted`, `message:failed`) to the dashboard frontend so they appear in the event timeline.

**Depends on:** None (can be done in parallel with Tasks 102-105)

---

### Context

ActorServer emits lifecycle events after message processing completes. The dashboard should display these in the event timeline. They don't affect tree visualization or blackboard state — they're informational timeline entries.

### Files

- Modify: `dashboard/src/lib/types.ts`
- Modify: `dashboard/src/lib/api.ts`
- Modify: `dashboard/src/lib/stores.svelte.ts`

---

- [ ] **Step 1: Add lifecycle event interfaces to types.ts**

Edit `dashboard/src/lib/types.ts`, add after `StrategyDecisionEvent` (line 184):

```ts
// ---- Actor lifecycle events ------------------------------------------------

export interface MessageProcessedEvent {
  messageId: string;
  treeStatus: string;
}

export interface MessageInterruptedEvent {
  messageId: string;
}

export interface MessageFailedEvent {
  messageId: string;
  error: string;
}
```

- [ ] **Step 2: Add lifecycle events to SseEventMap**

Edit `dashboard/src/lib/types.ts`, add to the `SseEventMap` type (around line 213):

```ts
'message:processed': MessageProcessedEvent;
'message:interrupted': MessageInterruptedEvent;
'message:failed': MessageFailedEvent;
```

- [ ] **Step 3: Register lifecycle event names in api.ts**

Edit `dashboard/src/lib/api.ts`, add to the `eventNames` array (around line 113, after `'strategy:decision'`):

```ts
'message:processed',
'message:interrupted',
'message:failed',
```

- [ ] **Step 4: Add event category mapping in stores.svelte.ts**

Edit `dashboard/src/lib/stores.svelte.ts`, add to `EVENT_CATEGORIES` (around line 52):

```ts
'message:processed': 'lifecycle',
'message:interrupted': 'lifecycle',
'message:failed': 'lifecycle',
```

Add `'lifecycle'` to the default `activeFilters` set (line 114):

```ts
let activeFilters = $state<Set<string>>(
  new Set(['nodes', 'agent', 'blackboard', 'strategy', 'lifecycle']),
);
```

- [ ] **Step 5: Add SSE handlers in stores.svelte.ts**

Edit `dashboard/src/lib/stores.svelte.ts`, add in `connect()` (after the `strategy:decision` handler, around line 309):

```ts
'message:processed'(data, id) {
  pushEvent('message:processed', data, id);
},
'message:interrupted'(data, id) {
  pushEvent('message:interrupted', data, id);
},
'message:failed'(data, id) {
  pushEvent('message:failed', data, id);
},
```

- [ ] **Step 6: Update _resetForTest to include lifecycle filter**

Edit `dashboard/src/lib/stores.svelte.ts` in `_resetForTest()` (line 369):

```ts
activeFilters = new Set(['nodes', 'agent', 'blackboard', 'strategy', 'lifecycle']);
```

- [ ] **Step 7: Verify TypeScript compilation**

Run: `cd dashboard && npx tsc --noEmit` (or `npm run typecheck` if available for dashboard)
Expected: No type errors

- [ ] **Step 8: Run dashboard build**

Run: `npm run build`
Expected: Dashboard builds successfully

- [ ] **Step 9: Commit**

```bash
git add dashboard/src/lib/types.ts dashboard/src/lib/api.ts dashboard/src/lib/stores.svelte.ts
git commit -m "feat(dashboard): add lifecycle event types for ActorServer integration"
```
