import { RingBuffer } from "../ring-buffer.js";
import { Osc133Parser, type Osc133Mark } from "./osc133.js";
import type { ScrollbackStore, ScrollbackRecord } from "./scrollback-store.js";

export type ReplayEvent =
  | { type: "replay-start"; fromSeq: number }
  | { type: "replay-evicted"; fromSeq: number; nextSeq: number }
  | { type: "output"; seq: number; data: string }
  | { type: "block-mark"; seq: number; mark: Osc133Mark }
  | { type: "replay-end"; toSeq: number | null };

export interface ShellReplayBufferOptions {
  maxBytes?: number;
  scrollbackStore?: ScrollbackStore;
  sessionName?: string;
}

export class ShellReplayBuffer {
  private readonly buffer: RingBuffer;
  private readonly osc133 = new Osc133Parser();
  private readonly scrollbackStore?: ScrollbackStore;
  private readonly sessionName?: string;
  private seqOffset = 0;

  constructor(options: ShellReplayBufferOptions = {}) {
    this.buffer = new RingBuffer(options.maxBytes);
    this.scrollbackStore = options.scrollbackStore;
    this.sessionName = options.sessionName;
  }

  write(data: string): { seq: number | null; stored: boolean } {
    const rawSeq = this.buffer.write(data);
    return { seq: rawSeq === null ? null : this.seqOffset + rawSeq, stored: rawSeq !== null };
  }

  async writePersistent(data: string): Promise<{ seq: number | null; stored: boolean }> {
    await this.seedOffsetFromScrollback();
    const result = this.write(data);
    if (result.seq === null || !this.scrollbackStore || !this.sessionName) {
      return result;
    }

    const parsed = this.osc133.write(data);
    const records: ScrollbackRecord[] = [
      { type: "output", seq: result.seq, data: parsed.data },
      ...parsed.marks.map((mark): ScrollbackRecord => ({ type: "block-mark", seq: result.seq!, mark })),
    ];
    await this.scrollbackStore.append(this.sessionName, records);
    return result;
  }

  replayFrom(fromSeq: number): ReplayEvent[] {
    const rawFromSeq = Math.max(0, fromSeq - this.seqOffset);
    const chunks = this.buffer.getSince(rawFromSeq);
    const events: ReplayEvent[] = [{ type: "replay-start", fromSeq }];
    const firstSeq =
      typeof chunks[0]?.seq === "number" ? this.seqOffset + chunks[0]!.seq : undefined;

    if (typeof firstSeq === "number" && firstSeq > fromSeq) {
      events.push({ type: "replay-evicted", fromSeq, nextSeq: firstSeq });
    }

    for (const chunk of chunks) {
      events.push({ type: "output", seq: this.seqOffset + chunk.seq, data: chunk.data });
    }

    events.push({ type: "replay-end", toSeq: this.lastSeq });
    return events;
  }

  async replayFromSeq(fromSeq: number): Promise<ReplayEvent[]> {
    const cold =
      this.scrollbackStore && this.sessionName
        ? await this.scrollbackStore.readSince(this.sessionName, fromSeq)
        : [];
    const hot = this.replayFrom(fromSeq)
      .filter((event): event is Extract<ReplayEvent, { type: "output" | "block-mark" }> => (
        event.type === "output" || event.type === "block-mark"
      ));
    const bySeqAndType = new Map<string, Extract<ReplayEvent, { type: "output" | "block-mark" }>>();
    for (const event of [...cold, ...hot]) {
      bySeqAndType.set(`${event.seq}:${event.type}:${event.type === "block-mark" ? event.mark.code : ""}`, event);
    }
    const ordered = Array.from(bySeqAndType.values()).sort((a, b) => a.seq - b.seq);
    return [
      { type: "replay-start", fromSeq },
      ...ordered,
      { type: "replay-end", toSeq: this.lastSeq ?? ordered.at(-1)?.seq ?? null },
    ];
  }

  get lastSeq(): number | null {
    return this.buffer.nextSeq === 0 ? null : this.seqOffset + this.buffer.nextSeq - 1;
  }

  private async seedOffsetFromScrollback(): Promise<void> {
    if (!this.scrollbackStore || !this.sessionName || this.buffer.nextSeq > 0) {
      return;
    }
    const latest = await this.scrollbackStore.latestSeq(this.sessionName);
    if (latest !== null) {
      this.seqOffset = latest + 1;
    }
  }
}
