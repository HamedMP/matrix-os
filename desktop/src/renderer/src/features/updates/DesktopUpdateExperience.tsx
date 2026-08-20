import { useEffect, useLayoutEffect, useState } from "react";
import { invoke } from "../../lib/operator";
import { useDesktopUpdate } from "../../stores/desktop-update";
import { useUi } from "../../stores/ui";
import ManualUpdateDialog from "./ManualUpdateDialog";
import WhatsNewDialog from "./WhatsNewDialog";

export default function DesktopUpdateExperience() {
  const manualDialogOpen = useDesktopUpdate((state) => state.manualDialogOpen);
  const whatsNewOpen = useDesktopUpdate((state) => state.whatsNewOpen);
  const acquireRendererOverlay = useUi((state) => state.acquireRendererOverlay);
  const releaseRendererOverlay = useUi((state) => state.releaseRendererOverlay);
  const updateOverlayOpen = manualDialogOpen || whatsNewOpen;
  const [nativeEmbedsSuspended, setNativeEmbedsSuspended] = useState(false);

  useEffect(() => useDesktopUpdate.getState().initialize(), []);

  // Hold renderer-driven embeds inactive immediately, then wait for the trusted
  // core to confirm that every native view is detached before painting a dialog.
  useLayoutEffect(() => {
    if (!updateOverlayOpen) return;
    let active = true;
    acquireRendererOverlay();
    void invoke("embed:suspend-all", {})
      .then(({ ok }) => {
        if (active && ok) setNativeEmbedsSuspended(true);
      })
      .catch(() => {
        console.warn("[desktop-update] failed to suspend native embeds");
      });
    return () => {
      active = false;
      setNativeEmbedsSuspended(false);
      releaseRendererOverlay();
    };
  }, [acquireRendererOverlay, releaseRendererOverlay, updateOverlayOpen]);

  if (updateOverlayOpen && !nativeEmbedsSuspended) return null;

  return (
    <>
      <ManualUpdateDialog />
      <WhatsNewDialog />
    </>
  );
}
