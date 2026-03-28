// Component
export { default as Cartographer } from './provider.svelte';

// Context
export { getClient } from './context.js';

// Reactive getters
export { getConnectionStatus, getTreeStatus } from './status.svelte.js';
export { getBlackboard, getBlackboardSnapshot } from './blackboard.svelte.js';

// Factories
export { createCommand } from './command.svelte.js';

// Typed runes
export { createTypedRunes } from './typed-runes.js';

// Event subscriptions
export { onClientEvent, onTreeEvent } from './events.svelte.js';

// Types
export type { TreeStatusInfo, ConnectionStatus } from './types.js';
export type { BlackboardRef, BlackboardSnapshotRef } from './blackboard.svelte.js';
export type { ConnectionStatusRef, TreeStatusRef } from './status.svelte.js';
export type { CommandRef } from './command.svelte.js';

// Test utilities
export { createMockClient, createTestContext } from './test-utils.svelte.js';
