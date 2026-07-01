import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RunEvent, RunEventType } from '@beaver/core';
import type { AppendEventInput, EventStore } from './eventStore';

/**
 * Append-only run event log (D19). Each append goes to the durable store (which
 * assigns the monotonic `seq`), is mirrored write-only to
 * `<runsDir>/<runId>/events.jsonl` for inspection, and is fanned out to live
 * subscribers. `readSince` replays persisted events after a cursor so a
 * subscriber can catch up with no gap. The JSONL mirror is never read back as
 * truth — the store is the source (D6).
 */
export class EventLog {
  private readonly emitter = new EventEmitter();

  constructor(
    private readonly store: EventStore,
    private readonly runsDir: string
  ) {
    this.emitter.setMaxListeners(0);
  }

  async append(runId: string, type: RunEventType, payload: Record<string, unknown> = {}): Promise<RunEvent> {
    const input: AppendEventInput = { runId, type, payload };
    const event = this.store.appendEvent(input);
    await this.mirror(event);
    this.emitter.emit('event', event);
    return event;
  }

  /** Gap-free catch-up: persisted events with `seq > sinceSeq`, optionally one run. */
  readSince(sinceSeq: number, runId?: string): RunEvent[] {
    return this.store.readEventsSince(sinceSeq, runId);
  }

  on(listener: (event: RunEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }

  private async mirror(event: RunEvent): Promise<void> {
    const dir = path.join(this.runsDir, event.runId);
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(path.join(dir, 'events.jsonl'), `${JSON.stringify(event)}\n`, 'utf8');
  }
}
