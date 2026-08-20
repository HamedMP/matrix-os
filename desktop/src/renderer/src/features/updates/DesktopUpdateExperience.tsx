import { useEffect } from "react";
import { useDesktopUpdate } from "../../stores/desktop-update";
import ManualUpdateDialog from "./ManualUpdateDialog";
import WhatsNewDialog from "./WhatsNewDialog";

export default function DesktopUpdateExperience() {
  useEffect(() => useDesktopUpdate.getState().initialize(), []);
  return (
    <>
      <ManualUpdateDialog />
      <WhatsNewDialog />
    </>
  );
}
