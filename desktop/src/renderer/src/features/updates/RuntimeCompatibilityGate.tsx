import { useLayoutEffect, useState, type ReactNode } from "react";
import type { RuntimeCompatibilityStatus } from "@matrix-os/contracts";
import { AlertCircle } from "../../lib/hugeicons";
import { Button, Dialog } from "../../design/primitives";
import { useRuntimeCompatibility } from "../../lib/runtime-compatibility";
import { invoke } from "../../lib/operator";
import { useConnection } from "../../stores/connection";
import { useDesktopUpdate } from "../../stores/desktop-update";
import { useTabs } from "../../stores/tabs";
import { useUi } from "../../stores/ui";

const NOTICE_COPY = {
  legacy: {
    title: "Check for updates",
    detail: "This computer can't confirm compatibility with Desktop. If an app isn't loading, update Desktop or this computer. You can keep working in the meantime.",
  },
  "desktop-update-required": {
    title: "Update Desktop",
    detail: "This computer needs a newer version of Matrix OS Desktop. Some apps may not work until you update. Your files and conversations are safe.",
  },
  "runtime-update-required": {
    title: "Update this computer",
    detail: "Desktop needs a newer version of this computer's software. Some apps may not work until you update. Your files and conversations are safe.",
  },
  unavailable: {
    title: "Unable to check compatibility",
    detail: "Check your connection and try again. You can keep using your workspace while the connection recovers.",
  },
} as const;

/** Advisory only: never move the titlebar, hide apps, or unmount drafts. */
export default function RuntimeCompatibilityGate({ children }: { children: ReactNode }) {
  const api = useConnection((state) => state.api);
  const { status, refresh } = useRuntimeCompatibility(api);
  // At most four statuses per computer session; polling must not nag after dismissal.
  const [dismissed, setDismissed] = useState<RuntimeCompatibilityStatus[]>([]);
  const [nativeEmbedsSuspended, setNativeEmbedsSuspended] = useState(false);
  const notice = status === "checking" || status === "compatible" ? null : status;
  const open = notice !== null && !dismissed.includes(notice);
  const close = () => {
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
      console.warn("[runtime-compatibility] embed suspension failed:", error instanceof Error ? error.name : "UnknownError");
      if (active && notice) setDismissed((previous) => previous.includes(notice) ? previous : [...previous, notice]);
    });
    return () => {
      active = false;
      setNativeEmbedsSuspended(false);
      useUi.getState().releaseRendererOverlay();
    };
  }, [notice, open]);

  const desktopUpdates = () => {
    close();
    void useDesktopUpdate.getState().check();
  };
  const computerUpdates = () => {
    close();
    useUi.getState().requestSettingsSection("system");
    useTabs.getState().openTab({ kind: "settings", title: "Settings" });
  };
  const retry = () => { close(); refresh(); };
  const copy = notice ? NOTICE_COPY[notice] : null;
  return (
    <>
      {children}
      {copy ? (
        <Dialog open={open && nativeEmbedsSuspended} onClose={close} title={copy.title} width={560} placement="center" preserveTitlebar>
          <div className="flex items-start gap-4 px-6 pt-6 pb-5">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl"
              style={{ background: "var(--update-action-muted)", color: "var(--update-action)" }}>
              <AlertCircle size={22} />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-lg font-semibold" style={{ color: "var(--text-primary)" }}>{copy.title}</h2>
              <p className="mt-1 text-sm leading-5" style={{ color: "var(--text-secondary)" }}>{copy.detail}</p>
            </div>
          </div>
          <div className="flex flex-wrap justify-end gap-2 border-t px-6 py-4" style={{ borderColor: "var(--border-subtle)" }}>
            <Button variant="ghost" onClick={close}>Later</Button>
            {notice === "unavailable" ? <Button variant="primary" onClick={retry}>Try again</Button> : (
              <>
                <Button variant={notice === "runtime-update-required" ? "primary" : "subtle"} onClick={computerUpdates}>Computer updates</Button>
                <Button variant={notice === "runtime-update-required" ? "subtle" : "primary"} onClick={desktopUpdates}>Check Desktop updates</Button>
              </>
            )}
          </div>
        </Dialog>
      ) : null}
    </>
  );
}
