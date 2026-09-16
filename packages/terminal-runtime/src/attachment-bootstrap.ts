import { TerminalRuntimeError } from "./errors.js";
import type { ZellijAttachment } from "./runtime.js";

const MAX_BOOTSTRAP_BYTES = 1024 * 1024;
const MAX_BOOTSTRAP_CHUNKS = 4096;

/** Retain the redraw emitted before openAttachment resolves and a viewer exists. */
export async function openBufferedAttachment(
  open: (onData: (data: Uint8Array) => void) => Promise<ZellijAttachment>,
  deliver: (data: Uint8Array) => void,
): Promise<{ handle: ZellijAttachment; flush(): void }> {
  let pending: Uint8Array[] = [];
  let bytes = 0;
  let buffering = true;
  let failed = false;
  let handle: ZellijAttachment;
  try {
    handle = await open((data) => {
      if (failed || data.byteLength === 0) return;
      if (!buffering) { deliver(data); return; }
      bytes += data.byteLength;
      if (bytes > MAX_BOOTSTRAP_BYTES || pending.length >= MAX_BOOTSTRAP_CHUNKS) {
        failed = true;
        pending = [];
        return;
      }
      pending.push(data);
    });
  } catch (error) {
    failed = true;
    pending = [];
    throw error;
  }
  if (failed) {
    await handle.close();
    throw new TerminalRuntimeError("capacity");
  }
  return {
    handle,
    flush() {
      buffering = false;
      const output = pending;
      pending = [];
      for (const data of output) deliver(data);
    },
  };
}
