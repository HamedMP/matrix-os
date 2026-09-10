import { useLayoutEffect, useState, type ReactNode } from "react";
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
  const { status, noticeKey } = useRuntimeCompatibility(api);
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const [operationHidden, setOperationHidden] = useState(false);
  // Dismiss the current release pair, not every future mismatch on this computer.
  // Keep only the last 16 pairs and scope them to the current API connection.
  const [dismissed, setDismissed] = useState<{ api: typeof api; keys: string[] }>({ api, keys: [] });
  const [nativeEmbedsSuspended, setNativeEmbedsSuspended] = useState(false);
  const notice = status === "checking" || status === "aligned" || status === "unavailable" ? null : noticeKey;
  const requestedOpen = notice !== null && (dismissed.api !== api || !dismissed.keys.includes(notice));
  const repair = useCompatibilityRepair(api, runtimeSlot, requestedOpen);
  const open = requestedOpen || (repair.busy && !operationHidden);
  const dismiss = (key: string) => setDismissed((previous) => {
    const keys = previous.api === api ? previous.keys : [];
    return { api, keys: keys.includes(key) ? keys : [...keys, key].slice(-16) };
  });
  const close = () => {
    setOperationHidden(true);
    if (notice) dismiss(notice);
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
      if (active && notice) dismiss(notice);
    });
    return () => {
      active = false;
      setNativeEmbedsSuspended(false);
      useUi.getState().releaseRendererOverlay();
    };
  }, [api, notice, open]);

  return (
    <>
      {children}
      <Dialog open={open && nativeEmbedsSuspended} onClose={close} title="Update Matrix OS" width={640} placement="center" preserveTitlebar>
        <CompatibilityUpdatePanel repair={{ ...repair, update: () => { setOperationHidden(false); return repair.update(); } }} close={close} />
      </Dialog>
    </>
  );
}
