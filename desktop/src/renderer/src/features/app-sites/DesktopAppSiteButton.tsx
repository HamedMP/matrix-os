import { useEffect, useMemo, useState } from "react";
import { AppSiteSharePopover } from "../../../../../../shell/src/components/app-sites/AppSiteSharePopover";
import { AppSiteSharePanel } from "../../../../../../shell/src/components/app-sites/AppSiteSharePanel";
import { createDesktopSiteClient } from "./site-client";
import { DESKTOP_Z_INDEX } from "../../design/layering";
import { Button } from "../../design/primitives";
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
  const email = useConnection(state => state.email);
  const userId = useConnection(state => state.userId);
  const [open, setOpen] = useState(false);
  const acquire = useUi(state => state.acquireRendererOverlay);
  const release = useUi(state => state.releaseRendererOverlay);
  useEffect(() => { if (!open) return; acquire(); return release; }, [open, acquire, release]);
  const client = useMemo(() => {
    if (!api) return null;
    return createDesktopSiteClient(api, runtimeSlot);
  }, [api, runtimeSlot, authGeneration]);
  return (
    <AppSiteSharePopover
      onOpenChange={setOpen}
      portalContainer={portalContainer}
      trigger={(
        <Button
          variant="subtle"
          disabled={!client}
          style={{ height: 28, padding: "0 10px", fontSize: 12, background: "var(--bg-app)", color: "var(--text-primary)", border: "1px solid var(--border-default)", boxShadow: "var(--shadow-1)" }}
        >
          Publish app
        </Button>
      )}
      open={open}
      zIndex={DESKTOP_Z_INDEX.popover}
    >
      {open && client ? (
        <AppSiteSharePanel
          key={`${runtimeSlot}:${authGeneration}:${appSlug}`}
          appSlug={appSlug}
          client={client}
          ownerIdentity={email ?? userId ?? "local-user"}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </AppSiteSharePopover>
  );
}
