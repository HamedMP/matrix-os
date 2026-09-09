import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { useRuntimeCompatibility } from "../../lib/runtime-compatibility";
import { invoke } from "../../lib/operator";
import { useConnection } from "../../stores/connection";
import { useDesktopUpdate } from "../../stores/desktop-update";
import { useUi } from "../../stores/ui";
import SystemSection from "../settings/sections/SystemSection";

export default function RuntimeCompatibilityGate({ children }: { children: ReactNode }) {
  const api = useConnection((state) => state.api);
  const { status, refresh } = useRuntimeCompatibility(api);
  const [opened, setOpened] = useState(false);
  const [computerUpdates, setComputerUpdates] = useState(false);
  const [actionError, setActionError] = useState(false);
  const compatible = status === "compatible" || status === "legacy";
  const incompatible = status === "desktop-update-required" || status === "runtime-update-required";
  // A transient probe failure must not tear down a working workspace or drafts.
  const blocked = incompatible || (!opened && !compatible);
  useEffect(() => { if (compatible) setOpened(true); }, [compatible]);
  useLayoutEffect(() => {
    if (!blocked || !opened) return;
    useUi.getState().acquireRendererOverlay();
    void invoke("embed:suspend-all", {}).catch((error: unknown) => {
      console.warn("[runtime-compatibility] embed suspension failed:", error instanceof Error ? error.name : "UnknownError");
    });
    return () => useUi.getState().releaseRendererOverlay();
  }, [blocked, opened]);

  const openWeb = async () => {
    setActionError(false);
    try {
      await invoke("shell:open-external", { url: "https://app.matrix-os.com/runtime" });
    } catch (error: unknown) {
      console.warn("[runtime-compatibility] web recovery failed:", error instanceof Error ? error.name : "UnknownError");
      setActionError(true);
    }
  };
  const actions = (
    <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
      <button className="rounded-md px-3 py-2" style={{ background: "var(--accent)", color: "var(--text-on-accent)" }} onClick={() => void useDesktopUpdate.getState().check()}>Check Desktop updates</button>
      <button className="rounded-md border px-3 py-2" style={{ borderColor: "var(--border-default)" }} onClick={() => setComputerUpdates((value) => !value)}>Computer updates</button>
      <button className="underline" onClick={() => void openWeb()}>Open web app</button>
      <button className="underline" onClick={refresh}>Try again</button>
    </div>
  );
  return (
    <>
      {blocked ? (
        <div className="flex min-h-0 flex-1 flex-col items-center overflow-auto p-8" style={{ color: "var(--text-primary)" }}>
          <div className="my-auto w-full max-w-xl">
            <h1 className="text-xl font-semibold">{status === "desktop-update-required" ? "Update Matrix OS Desktop to continue"
              : status === "runtime-update-required" ? "Update this computer to continue"
              : status === "checking" ? "Checking computer compatibility…" : "Unable to check this computer"}</h1>
            <p className="mt-2 text-sm" style={{ color: "var(--text-secondary)" }}>{incompatible
              ? "Desktop and this computer need compatible versions to load your apps. Your files and conversations remain on your computer."
              : "Check your connection, then try again. You can also use Matrix OS on the web."}</p>
            {status !== "checking" ? actions : null}
            {actionError ? <p role="alert">Unable to open the web app. Please try again.</p> : null}
            {computerUpdates ? <div className="mt-6"><SystemSection /></div> : null}
          </div>
        </div>
      ) : status === "legacy" || status === "unavailable" ? (
        <div role="status" className="border-b px-5 py-3 text-sm" style={{ borderColor: "var(--border-default)", color: "var(--text-secondary)" }}>
          {status === "legacy" ? "This computer does not report compatibility. If an app fails to load, check for updates."
            : "Compatibility could not be checked. You can keep working and try again."}
          {actions}
          {computerUpdates ? <SystemSection /> : null}
        </div>
      ) : null}
      {/* Preserve mounted drafts if a live VPS update changes compatibility. */}
      <div className="min-h-0 flex-1 flex-col" style={{ display: blocked ? "none" : "flex" }} inert={blocked}>
        {opened || compatible ? children : null}
      </div>
    </>
  );
}
