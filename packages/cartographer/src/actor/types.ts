export type ActorMessage =
  | TickMessage
  | CommandMessage
  | WriteMessage
  | SignalMessage;

export interface TickMessage {
  type: 'tick';
  id?: string;
}

export interface CommandMessage {
  type: 'command';
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

export interface MessageInterruptedEvent {
  messageId: string;
}

/** Generate a unique message ID. */
export function generateMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
