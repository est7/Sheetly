import type { RunEvent, RunEventType } from '@beaver/core';

export type AppendEventInput = {
  runId: string;
  type: RunEventType;
  payload: Record<string, unknown>;
};

/**
 * The durable side of the event log. `RunRepository` implements this; `EventLog`
 * depends only on this interface so it stays free of bun:sqlite (portable to the
 * main tsconfig). `appendEvent` returns the event stamped with its monotonic
 * `seq` (D19); `readEventsSince` powers gap-free replay / SSE catch-up.
 */
export interface EventStore {
  appendEvent(input: AppendEventInput): RunEvent;
  readEventsSince(sinceSeq: number, runId?: string): RunEvent[];
}
