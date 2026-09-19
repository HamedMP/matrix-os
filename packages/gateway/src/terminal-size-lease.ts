import type { TerminalRef, TerminalTabClientFrameSchema } from "@matrix-os/contracts";
import type { z } from "zod/v4";
type TerminalTabClientFrame = z.infer<typeof TerminalTabClientFrameSchema>;

/** Keep tab input leases and their workspace sizing proposals in sync. */
export function createTerminalSizeLease(ref: TerminalRef, send: (frame: TerminalTabClientFrame) => void) {
  let revoked = false;
  // Soft proposal dimensions are ignored; this releases only this stream's hard proposal.
  const release = () => send({ type: "resize", terminalRef: ref, mode: "soft", size: { cols: 120, rows: 36 } });
  return {
    revoke() { if (!revoked) { revoked = true; release(); } },
    // Revocation may race asynchronous runtime admission before stream assignment.
    attached() { if (revoked) release(); },
  };
}
