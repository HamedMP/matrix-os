import { useLayoutEffect, useState, type ReactNode } from "react";
import type { RuntimeCompatibilityStatus } from "@matrix-os/contracts";
import { Dialog } from "../../design/primitives";
import { useRuntimeCompatibility } from "../../lib/runtime-compatibility";
import { invoke } from "../../lib/operator";
import { useConnection } from "../../stores/connection";
import { useCompatibilityRepair } from "../../lib/use-compatibility-repair";
import CompatibilityUpdatePanel from "./CompatibilityUpdatePanel";
import { useUi } from "../../stores/ui";

/** Advisory only: never move the titlebar, hide apps, or unmount drafts. */
export default function RuntimeCompatibilityGate({ children }: { children: ReactNode }) {
  const api = useConnection((state) => state.api);
  const { status } = useRuntimeCompatibility(api);
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const [operationHidden, setOperationHidden] = useState(false);
  // At most four statuses per computer session; polling must not nag after dismissal.
  const [dismissed, setDismissed] = useState<RuntimeCompatibilityStatus[]>([]);
  const [nativeEmbedsSuspended, setNativeEmbedsSuspended] = useState(false);
  const notice = status === "checking" || status === "compatible" ? null : status;
  const requestedOpen = notice !== null && !dismissed.includes(notice);
  const repair = useCompatibilityRepair(api, runtimeSlot, requestedOpen);
  const open = requestedOpen || (repair.busy && !operationHidden);
  const close = () => {
    setOperationHidden(true);
    if (notice) setDismissed((previous) => previous.includes(notice) ? previous : [...previous, notice]);
  };
  useLayoutEffect(() => {
    if (!open) return;
    let active = true;
    useUi.getState().acquireRendererOverlay();
    void invoke("embed:suspend-all", {}).then(({ ok }) => {
      if (!ok) throw new Error("Native views could not be suspended");
      if (active) setNativeEmbedsSuspended(true);
    }).catch((error: unknown) => {
      setOperationHidden(true);
      console.warn("[runtime-compatibility] embed suspension failed:", error instanceof Error ? error.name : "UnknownError");
      if (active && notice) setDismissed((previous) => previous.includes(notice) ? previous : [...previous, notice]);
    });
    return () => {
      active = false;
      setNativeEmbedsSuspended(false);
      useUi.getState().releaseRendererOverlay();
    };
  }, [notice, open]);

  return (
    <>
      {children}
      <Dialog open={open && nativeEmbedsSuspended} onClose={close} title="Update Matrix OS" width={640} placement="center" preserveTitlebar>
        <CompatibilityUpdatePanel repair={{ ...repair, update: () => { setOperationHidden(false); return repair.update(); } }} close={close} />
      </Dialog>
    </>
  );
}
