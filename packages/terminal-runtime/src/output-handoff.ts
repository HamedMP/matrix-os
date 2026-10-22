import { TerminalRuntimeError } from "./errors.js";

/** Hold viewer output until the authoritative snapshot handshake is sent. */
export function createTerminalOutputHandoff(deliver: (data: Uint8Array) => void) {
  const pending: Uint8Array[] = [];
  let bytes = 0;
  let live = false;
  let closed = false;
  return {
    write(data: Uint8Array): void {
      if (closed) throw new TerminalRuntimeError("unavailable");
      if (live) { deliver(data); return; }
      if (bytes + data.byteLength > 1024 * 1024 || pending.length >= 256) {
        throw new TerminalRuntimeError("capacity");
      }
      pending.push(data.slice());
      bytes += data.byteLength;
    },
    flush(): void {
      if (closed || live) return;
      live = true;
      bytes = 0;
      for (const data of pending.splice(0)) deliver(data);
    },
    dispose(): void {
      closed = true;
      pending.splice(0);
      bytes = 0;
    },
  };
}
