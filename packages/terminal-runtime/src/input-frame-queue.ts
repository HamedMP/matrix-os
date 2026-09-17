import type { z } from "zod/v4";
import type { TerminalTabClientFrameSchema } from "@matrix-os/contracts";

type Frame = z.infer<typeof TerminalTabClientFrameSchema>;
type Handler = (frame: Frame) => Promise<void>;
const MAX_BATCHES = 32;
const MAX_RETAINED_BYTES = 1024 * 1024;
const MAX_INPUT_BATCH_BYTES = 64 * 1024;

/** Bounded, ordered input admission; paused until its downstream stream is ready. */
export class TerminalFrameQueue {
  private readonly frames: { frame: Frame; bytes: number }[] = [];
  private bytes = 0;
  private active = false;
  private closed = false;
  private handler: Handler | null = null;

  constructor(private readonly options: {
    onOverflow(): void;
    onError(error: unknown): void;
  }) {}

  enqueue(frame: Frame): void {
    if (this.closed) return;
    // Only waiting input can merge: never mutate a batch already being authorized.
    const tail = this.frames.at(-1);
    const merged = tail && mergeInput(tail.frame, frame);
    if (merged) {
      const bytes = Buffer.byteLength(JSON.stringify(merged));
      if (this.bytes - tail.bytes + bytes > MAX_RETAINED_BYTES) {
        this.close();
        this.options.onOverflow();
        return;
      }
      this.bytes += bytes - tail.bytes;
      tail.frame = merged;
      tail.bytes = bytes;
      return;
    }
    const bytes = Buffer.byteLength(JSON.stringify(frame));
    if (this.bytes + bytes > MAX_RETAINED_BYTES || this.frames.length + Number(this.active) >= MAX_BATCHES) {
      this.close();
      this.options.onOverflow();
      return;
    }
    this.frames.push({ frame, bytes });
    this.bytes += bytes;
    this.drain();
  }

  resume(handler: Handler): void {
    if (this.closed || this.handler) return;
    this.handler = handler;
    this.drain();
  }

  close(): void {
    this.closed = true;
    this.frames.splice(0);
    this.bytes = 0;
    this.handler = null;
  }

  private drain(): void {
    if (this.active || this.closed || !this.handler) return;
    this.active = true;
    void (async () => {
      try {
        while (!this.closed && this.handler) {
          const next = this.frames.shift();
          if (!next) break;
          await this.handler(next.frame);
          if (!this.closed) this.bytes -= next.bytes;
        }
      } catch (error: unknown) {
        this.close();
        this.options.onError(error);
      } finally {
        this.active = false;
      }
    })();
  }
}

function mergeInput(left: Frame, right: Frame): Frame | null {
  if (left.terminalRef.workspaceId !== right.terminalRef.workspaceId
    || left.terminalRef.tabId !== right.terminalRef.tabId) return null;
  if (left.type === "input" && right.type === "input") {
    if (Buffer.byteLength(left.data) + Buffer.byteLength(right.data) > MAX_INPUT_BATCH_BYTES) return null;
    // Each original string is independently UTF-8 encoded downstream.
    if (/[\uD800-\uDBFF]$/.test(left.data) && /^[\uDC00-\uDFFF]/.test(right.data)) return null;
    return { ...left, data: left.data + right.data };
  }
  if (left.type === "binary" && right.type === "binary") {
    const a = Buffer.from(left.dataBase64, "base64");
    const b = Buffer.from(right.dataBase64, "base64");
    if (a.length + b.length > MAX_INPUT_BATCH_BYTES) return null;
    return { ...left, dataBase64: Buffer.concat([a, b]).toString("base64") };
  }
  return null;
}
