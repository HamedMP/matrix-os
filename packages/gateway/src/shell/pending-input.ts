export const TERMINAL_SESSION_PENDING_INPUT_MAX_BYTES = 65_536;

export interface PendingTerminalInputQueue {
  readonly sizeBytes: number;
  enqueue(raw: string): boolean;
  drain(onMessage: (raw: string) => void): void;
  clear(): void;
}

export function createPendingTerminalInputQueue(
  maxBytes = TERMINAL_SESSION_PENDING_INPUT_MAX_BYTES,
): PendingTerminalInputQueue {
  const frames: string[] = [];
  let sizeBytes = 0;

  return {
    get sizeBytes() {
      return sizeBytes;
    },
    enqueue(raw: string) {
      const nextSize = sizeBytes + Buffer.byteLength(raw, "utf8");
      if (nextSize > maxBytes) {
        return false;
      }
      frames.push(raw);
      sizeBytes = nextSize;
      return true;
    },
    drain(onMessage) {
      for (const frame of frames.splice(0)) {
        onMessage(frame);
      }
      sizeBytes = 0;
    },
    clear() {
      frames.length = 0;
      sizeBytes = 0;
    },
  };
}
