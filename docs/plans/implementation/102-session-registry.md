# Task 102: SessionRegistry

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create the `SessionRegistry` class — a lightweight map from session names to provider session IDs with serialization support.

**Depends on:** None

**Spec Reference:** `docs/superpowers/specs/2026-03-23-agent-sessions-design.md` — SessionRegistry section

---

### Step 1: Write failing tests

Create `src/core/session-registry.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { SessionRegistry } from './session-registry.js';

describe('SessionRegistry', () => {
  describe('get / set / has', () => {
    it('returns undefined for unknown session name', () => {
      const registry = new SessionRegistry();
      expect(registry.get('unknown')).toBeUndefined();
    });

    it('stores and retrieves a session ID by name', () => {
      const registry = new SessionRegistry();
      registry.set('triage', 'sdk-session-abc');
      expect(registry.get('triage')).toBe('sdk-session-abc');
    });

    it('reports whether a session name exists', () => {
      const registry = new SessionRegistry();
      expect(registry.has('triage')).toBe(false);
      registry.set('triage', 'sdk-session-abc');
      expect(registry.has('triage')).toBe(true);
    });

    it('overwrites an existing session ID', () => {
      const registry = new SessionRegistry();
      registry.set('triage', 'old-id');
      registry.set('triage', 'new-id');
      expect(registry.get('triage')).toBe('new-id');
    });
  });

  describe('reset', () => {
    it('clears all sessions', () => {
      const registry = new SessionRegistry();
      registry.set('a', 'id-a');
      registry.set('b', 'id-b');
      registry.reset();
      expect(registry.has('a')).toBe(false);
      expect(registry.has('b')).toBe(false);
    });
  });

  describe('serialization', () => {
    it('toRecord returns a plain object of all sessions', () => {
      const registry = new SessionRegistry();
      registry.set('triage', 'id-1');
      registry.set('analysis', 'id-2');
      expect(registry.toRecord()).toEqual({
        triage: 'id-1',
        analysis: 'id-2',
      });
    });

    it('toRecord returns empty object when no sessions exist', () => {
      const registry = new SessionRegistry();
      expect(registry.toRecord()).toEqual({});
    });

    it('fromRecord restores a registry from a plain object', () => {
      const restored = SessionRegistry.fromRecord({
        triage: 'id-1',
        analysis: 'id-2',
      });
      expect(restored.get('triage')).toBe('id-1');
      expect(restored.get('analysis')).toBe('id-2');
    });

    it('fromRecord with empty object creates empty registry', () => {
      const restored = SessionRegistry.fromRecord({});
      expect(restored.has('anything')).toBe(false);
    });

    it('round-trips through toRecord and fromRecord', () => {
      const original = new SessionRegistry();
      original.set('a', 'id-a');
      original.set('b', 'id-b');
      const restored = SessionRegistry.fromRecord(original.toRecord());
      expect(restored.get('a')).toBe('id-a');
      expect(restored.get('b')).toBe('id-b');
    });
  });
});
```

### Step 2: Run tests to verify they fail

Run: `pnpm --filter cartographer exec vitest run src/core/session-registry.test.ts`

Expected: FAIL — `session-registry.js` does not exist.

### Step 3: Implement SessionRegistry

Create `src/core/session-registry.ts`:

```ts
/**
 * A lightweight map from named sessions to provider session IDs.
 *
 * The registry is scoped to a single tree run: it is created (or restored)
 * when the tree starts and cleared when the tree reaches a terminal status
 * (SUCCESS or FAILURE). Between ticks that return RUNNING, the registry
 * preserves all session state so agents can resume conversations across
 * ticks.
 *
 * Provider session IDs are opaque strings — the registry does not
 * interpret them. Each concrete Agent implementation maps them to
 * its provider's session concept (e.g. Claude SDK session, ACP session).
 */
export class SessionRegistry {
  private sessions = new Map<string, string>();

  /** Look up a provider session ID by name. Returns `undefined` if the name has not been registered. */
  get(name: string): string | undefined {
    return this.sessions.get(name);
  }

  /** Register or update a named session with a provider session ID. */
  set(name: string, id: string): void {
    this.sessions.set(name, id);
  }

  /** Check whether a named session has been registered. */
  has(name: string): boolean {
    return this.sessions.has(name);
  }

  /** Clear all registered sessions. Called when the tree reaches a terminal status. */
  reset(): void {
    this.sessions.clear();
  }

  /** Serialize to a plain record for persistence via StateStore. */
  toRecord(): Record<string, string> {
    return Object.fromEntries(this.sessions);
  }

  /** Restore a registry from a previously serialized record. */
  static fromRecord(data: Record<string, string>): SessionRegistry {
    const registry = new SessionRegistry();
    for (const [name, id] of Object.entries(data)) {
      registry.set(name, id);
    }
    return registry;
  }
}
```

### Step 4: Run tests to verify they pass

Run: `pnpm --filter cartographer exec vitest run src/core/session-registry.test.ts`

Expected: All pass.

### Step 5: Typecheck

Run: `pnpm typecheck`

### Step 6: Commit

```bash
git add packages/cartographer/src/core/session-registry.ts packages/cartographer/src/core/session-registry.test.ts
git commit -m "feat(core): add SessionRegistry for named session management"
```
