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
