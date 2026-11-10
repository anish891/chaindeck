// Types for stream.js, for the paper app (TypeScript). The dashboard uses stream.js directly.

export type StreamStatus = 'connecting' | 'connected' | 'reconnecting' | 'auth' | 'offline';

export interface StreamState {
  status: StreamStatus;
  stale: boolean;
  reason: string | null;
  lastTickAt: number | null;
  lastMessageAt: number | null;
  segments: Record<string, string> | null;
}

export interface StreamMessage {
  type: string;
  [key: string]: unknown;
}

export interface Stream {
  getState(): StreamState;
  subscribe(fn: (state: StreamState) => void): () => void;
  on(type: string, fn: (msg: any) => void): () => void;
  watch(msg: StreamMessage): void;
  unwatch(channel: string): void;
  send(msg: StreamMessage): boolean;
  retryNow(): void;
  close(): void;
}

export function createStream(opts?: { path?: string; url?: string | null }): Stream;
export const STATUS_TEXT: Record<StreamStatus, string>;
export function tickTime(ms: number | null | undefined): string;
