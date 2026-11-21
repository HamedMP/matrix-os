// herdr-core's framed wire format (schema/README.md at the pinned version):
// [channel u32 LE][kind u8][len u32 LE][payload], payload at most 16 MiB.
// Channel 0 carries JSON-RPC; other channels carry terminal stream bytes.
export const HC_FRAME = { DATA: 0, CREDIT: 1, CLOSE: 2, RESIZE: 3, FOCUS: 4 } as const;
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

/** Incremental decoder. Throws on a frame that claims more than the cap. */
export class HcFrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): HcFrame[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames: HcFrame[] = [];
    while (this.buffer.length >= HEADER) {
      const length = this.buffer.readUInt32LE(5);
      if (length > HC_MAX_PAYLOAD) throw new Error("frame too large");
      if (this.buffer.length < HEADER + length) break;
      frames.push({
        channel: this.buffer.readUInt32LE(0),
        kind: this.buffer.readUInt8(4),
        payload: this.buffer.subarray(HEADER, HEADER + length),
      });
      this.buffer = this.buffer.subarray(HEADER + length);
    }
    return frames;
  }
}
