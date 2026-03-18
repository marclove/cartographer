export interface TreeStatusInfo {
  status: string;
  durationMs: number;
  localTickCount: number;
}

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';
