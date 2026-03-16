# Task 92: Actor Message Types

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Define the message types used by TreeActor and ActorServer.

**Depends on:** None

**Spec Reference:** `docs/plans/2026-03-15-agent-enabled-application-framework.md` — Section 1 (Message Types)

---

### Step 1: Create actor types

Create `src/actor/types.ts`:

```ts
export type ActorMessage =
  | TickMessage
  | ActionMessage
  | WriteMessage
  | SignalMessage;

export interface TickMessage {
  type: 'tick';
  id?: string; // message ID, auto-generated if not provided
}

export interface ActionMessage {
  type: 'action';
  name: string;
  payload?: unknown;
  id?: string;
}

export interface WriteMessage {
  type: 'write';
  key: string;
  value: unknown;
  id?: string;
}

export interface SignalMessage {
  type: 'signal';
  signal: 'stop' | 'reset' | 'abort';
  id?: string;
}

/** Result published to SSE after processing completes. */
export interface MessageProcessedEvent {
  messageId: string;
  treeStatus: string;
}

/** Result published to SSE when processing fails. */
export interface MessageFailedEvent {
  messageId: string;
  error: string;
}

/** Generate a unique message ID. */
export function generateMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
```

### Step 2: Write tests

Create `src/actor/types.test.ts`:

```ts
describe('generateMessageId', () => {
  it('produces unique IDs', () => {
    const a = generateMessageId();
    const b = generateMessageId();
    expect(a).not.toBe(b);
  });

  it('starts with msg- prefix', () => {
    expect(generateMessageId()).toMatch(/^msg-/);
  });
});
```

### Step 3: Run tests

Run: `npx vitest run src/actor/types.test.ts`

### Step 4: Commit

```bash
git add src/actor/types.ts src/actor/types.test.ts
git commit -m "feat(actor): define actor message types"
```
