import { RingBuffer } from "../ring-buffer.js";

export type ReplayEvent =
  | { type: "replay-start"; fromSeq: number }
  | { type: "replay-evicted"; fromSeq: number; nextSeq: number }
  | { type: "output"; seq: number; data: string }
  | { type: "replay-end"; toSeq: number | null };

export interface ShellReplayBufferOptions {
  maxBytes?: number;
}

export class ShellReplayBuffer {
  private readonly buffer: RingBuffer;

  constructor(options: ShellReplayBufferOptions = {}) {
    this.buffer = new RingBuffer(options.maxBytes);
  }

  write(data: string): { seq: number | null; stored: boolean } {
    const seq = this.buffer.write(data);
    return { seq, stored: seq !== null };
  }

  replayFrom(fromSeq: number): ReplayEvent[] {
    const chunks = this.buffer.getSince(fromSeq);
    const events: ReplayEvent[] = [{ type: "replay-start", fromSeq }];
    const firstSeq = chunks[0]?.seq;

    if (typeof firstSeq === "number" && firstSeq > fromSeq) {
      events.push({ type: "replay-evicted", fromSeq, nextSeq: firstSeq });
    }

    for (const chunk of chunks) {
      events.push({ type: "output", seq: chunk.seq, data: chunk.data });
    }

    events.push({ type: "replay-end", toSeq: this.lastSeq });
    return events;
  }

  get lastSeq(): number | null {
    return this.buffer.nextSeq === 0 ? null : this.buffer.nextSeq - 1;
  }
}
