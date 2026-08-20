import { useEffect } from "react";
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

  useEffect(() => useDesktopUpdate.getState().initialize(), []);

  useEffect(() => {
    if (!updateOverlayOpen) return;
    acquireRendererOverlay();
    return releaseRendererOverlay;
  }, [acquireRendererOverlay, releaseRendererOverlay, updateOverlayOpen]);

  return (
    <>
      <ManualUpdateDialog />
      <WhatsNewDialog />
    </>
  );
}
