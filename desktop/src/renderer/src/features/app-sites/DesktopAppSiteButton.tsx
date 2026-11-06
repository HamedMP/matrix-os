import { useEffect, useMemo, useState } from "react";
import { AppSiteSharePanel } from "../../../../../../shell/src/components/app-sites/AppSiteSharePanel";
import { createDesktopSiteClient } from "./site-client";
import { Button, Dialog } from "../../design/primitives";
import { useConnection } from "../../stores/connection";
import { useUi } from "../../stores/ui";

export function DesktopAppSiteButton({
  appSlug,
  portalContainer,
}: {
  appSlug: string;
  portalContainer?: HTMLElement | null;
}) {
  const api = useConnection(state => state.api);
  const runtimeSlot = useConnection(state => state.runtimeSlot);
  const authGeneration = useConnection(state => state.authGeneration);
  const [open, setOpen] = useState(false);
  const acquire = useUi(state => state.acquireRendererOverlay);
  const release = useUi(state => state.releaseRendererOverlay);
  useEffect(() => { if (!open) return; acquire(); return release; }, [open, acquire, release]);
  const client = useMemo(() => {
    if (!api) return null;
    return createDesktopSiteClient(api, runtimeSlot);
  }, [api, runtimeSlot, authGeneration]);
  return (
    <Dialog
      modal={false}
      onOpenChange={setOpen}
      portalContainer={portalContainer}
      trigger={(
        <Button
          variant="subtle"
          disabled={!client}
          style={{ background: "#171717", color: "#f4f4f5", border: "1px solid #3f3f46" }}
        >
          Publish app
        </Button>
      )}
      open={open}
      onClose={() => setOpen(false)}
      title="Share app"
      width={576}
      placement="center"
    >
      {open && client ? (
        <AppSiteSharePanel
          key={`${runtimeSlot}:${authGeneration}:${appSlug}`}
          appSlug={appSlug}
          client={client}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </Dialog>
  );
}
