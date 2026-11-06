import type { PreviewPairLaunchContext } from "@matrix-os/contracts/preview-pair-launch";
import { acknowledgePreviewDesktop } from "./preview-pair-ready";

interface WindowReadiness {
  once(event: "did-finish-load", listener: () => void): unknown;
}

/** Process-scoped launcher handshake. Explicit second-instance requests use the
 * separate Source-verified reopen handshake. */
export function createPreviewStartupAcknowledgement(context: PreviewPairLaunchContext | null,
  port: string | undefined, onError: (error: unknown) => void) {
  let acknowledged = false;
  return (contents: WindowReadiness) => {
    if (!context || acknowledged) return;
    contents.once("did-finish-load", () => {
      if (acknowledged) return;
      acknowledged = true;
      void acknowledgePreviewDesktop(context, port).catch(onError);
    });
  };
}
