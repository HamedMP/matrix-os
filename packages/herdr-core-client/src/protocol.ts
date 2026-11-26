// herdr-core's framed wire format (schema/README.md at the pinned version):
// [channel u32 LE][kind u8][len u32 LE][payload], payload at most 16 MiB.
// Channel 0 carries JSON-RPC; other channels carry terminal stream bytes.
// FOCUS (1 gained, 0 lost) and FACTS (JSON display facts) go viewer → core.
export const HC_FRAME = { DATA: 0, CREDIT: 1, CLOSE: 2, RESIZE: 3, FOCUS: 4, FACTS: 5 } as const;
export const HC_MAX_PAYLOAD = 16 * 1024 * 1024;
const HEADER = 9;

export interface HcFrame { channel: number; kind: number; payload: Buffer }

export function encodeFrame(channel: number, kind: number, payload: Buffer): Buffer {
  if (payload.length > HC_MAX_PAYLOAD) throw new Error("frame too large");
  const header = Buffer.alloc(HEADER);
  header.writeUInt32LE(channel, 0);
  header.writeUInt8(kind, 4);
  header.writeUInt32LE(payload.length, 5);
  return Buffer.concat([header, payload]);
}

export function encodeCredit(channel: number, bytes: number): Buffer {
  const payload = Buffer.alloc(4);
  payload.writeUInt32LE(bytes, 0);
  return encodeFrame(channel, HC_FRAME.CREDIT, payload);
}

export function encodeResize(channel: number, cols: number, rows: number): Buffer {
  const payload = Buffer.alloc(4);
  payload.writeUInt16LE(cols, 0);
  payload.writeUInt16LE(rows, 2);
  return encodeFrame(channel, HC_FRAME.RESIZE, payload);
}

export function encodeFocus(channel: number, focused: boolean): Buffer {
  return encodeFrame(channel, HC_FRAME.FOCUS, Buffer.from([focused ? 1 : 0]));
}

/**
 * What the viewer's terminal looks like, as herdr-core's `Display`: default
 * colours as `#rrggbb` and the cell size in pixels. The core answers the
 * program's colour and size queries from it and passes theme changes on.
 */
export interface HcDisplayFacts { fg?: string; bg?: string; cursor?: string; cell?: [number, number] }

export function encodeFacts(channel: number, facts: HcDisplayFacts): Buffer {
  return encodeFrame(channel, HC_FRAME.FACTS, Buffer.from(JSON.stringify(facts)));
}

/**
 * Incremental decoder. Throws on a frame that claims more than the cap.
 *
 * A frame that arrives whole within one read is handed out as a view of that
 * read, without copying. Only a frame split across reads is copied, once, into
 * a buffer sized from its header; reads are never joined together.
 */
export class HcFrameDecoder {
  private readonly header = Buffer.alloc(HEADER);
  private headerFill = 0;
  private partial: { channel: number; kind: number; payload: Buffer; filled: number } | null = null;

  push(chunk: Buffer): HcFrame[] {
    const frames: HcFrame[] = [];
    let offset = 0;
    while (offset < chunk.length) {
      if (this.partial) {
        const partial = this.partial;
        const take = Math.min(partial.payload.length - partial.filled, chunk.length - offset);
        chunk.copy(partial.payload, partial.filled, offset, offset + take);
        partial.filled += take;
        offset += take;
        if (partial.filled === partial.payload.length) {
          this.partial = null;
          frames.push({ channel: partial.channel, kind: partial.kind, payload: partial.payload });
        }
        continue;
      }
      if (this.headerFill > 0 || chunk.length - offset < HEADER) {
        const take = Math.min(HEADER - this.headerFill, chunk.length - offset);
        chunk.copy(this.header, this.headerFill, offset, offset + take);
        this.headerFill += take;
        offset += take;
        if (this.headerFill < HEADER) break;
        this.headerFill = 0;
        this.begin(this.header, 0, frames);
        continue;
      }
      const length = chunk.readUInt32LE(offset + 5);
      if (length > HC_MAX_PAYLOAD) throw new Error("frame too large");
      const start = offset + HEADER;
      if (chunk.length - start >= length) {
        frames.push({ channel: chunk.readUInt32LE(offset), kind: chunk.readUInt8(offset + 4), payload: chunk.subarray(start, start + length) });
        offset = start + length;
        continue;
      }
      this.begin(chunk, offset, frames);
      offset = start;
    }
    return frames;
  }

  /** A header has been read whole; its payload is still to come (or empty). */
  private begin(source: Buffer, at: number, frames: HcFrame[]): void {
    const length = source.readUInt32LE(at + 5);
    if (length > HC_MAX_PAYLOAD) throw new Error("frame too large");
    const channel = source.readUInt32LE(at);
    const kind = source.readUInt8(at + 4);
    if (length === 0) { frames.push({ channel, kind, payload: Buffer.alloc(0) }); return; }
    this.partial = { channel, kind, payload: Buffer.allocUnsafe(length), filled: 0 };
  }
}
