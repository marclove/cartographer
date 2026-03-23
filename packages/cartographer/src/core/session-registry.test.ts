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
