export type ActorMessage =
  | TickMessage
  | ActionMessage
  | WriteMessage
  | SignalMessage;

export interface TickMessage {
  type: 'tick';
  id?: string;
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
  signal: 'stop' | 'reset' | 'abort' | 'resume';
  id?: string;
}

export interface MessageProcessedEvent {
  messageId: string;
  treeStatus: string;
}

export interface MessageFailedEvent {
  messageId: string;
  error: string;
}

/** Generate a unique message ID. */
export function generateMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
