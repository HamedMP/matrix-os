import type { TerminalRef } from "@matrix-os/contracts";

export function terminalSnapshotFrame(terminalRef: TerminalRef, revision: number, seq: number, ansi: string) {
  return {
    type: "snapshot", terminalRef, revision, presentationRevision: 1, seq,
    canonicalSize: { cols: 120, rows: 40 }, viewport: { top: 0, rows: 40 }, ansi,
  };
}
