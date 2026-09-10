import {
  MAX_TERMINAL_RUNTIME_REQUEST_FRAME_BYTES,
  MAX_TERMINAL_RUNTIME_RESPONSE_FRAME_BYTES,
} from "./limits.js";

function validateFrameLimit(value: number): number {
  if (!Number.isSafeInteger(value)
    || value < 1
    || value > MAX_TERMINAL_RUNTIME_RESPONSE_FRAME_BYTES) {
    throw new Error("Terminal runtime frame limit is invalid");
  }
  return value;
}

export function encodeSocketFrame(
  value: unknown,
  maxFrameBytes = MAX_TERMINAL_RUNTIME_REQUEST_FRAME_BYTES,
): Buffer {
  const frameLimit = validateFrameLimit(maxFrameBytes);
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.byteLength > frameLimit) throw new Error("Terminal runtime frame is too large");
  const frame = Buffer.allocUnsafe(4 + body.byteLength);
  frame.writeUInt32BE(body.byteLength, 0);
  body.copy(frame, 4);
  return frame;
}

export class SocketFrameDecoder {
  private pending = Buffer.alloc(0);
  private readonly maxFrameBytes: number;

  constructor(maxFrameBytes = MAX_TERMINAL_RUNTIME_REQUEST_FRAME_BYTES) {
    this.maxFrameBytes = validateFrameLimit(maxFrameBytes);
  }

  push(chunk: Buffer): unknown[] {
    if (this.pending.byteLength + chunk.byteLength > this.maxFrameBytes + 4) {
      throw new Error("Terminal runtime frame is too large");
    }
    this.pending = Buffer.concat([this.pending, chunk]);
    const frames: unknown[] = [];
    while (this.pending.byteLength >= 4) {
      const length = this.pending.readUInt32BE(0);
      if (length > this.maxFrameBytes) throw new Error("Terminal runtime frame is too large");
      if (this.pending.byteLength < length + 4) break;
      const body = this.pending.subarray(4, length + 4);
      this.pending = this.pending.subarray(length + 4);
      frames.push(JSON.parse(body.toString("utf8")));
    }
    return frames;
  }
}
