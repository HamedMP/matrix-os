import { useEffect, useMemo, useState } from "react";
import { AppSitePanel } from "../../../../../../shell/src/components/app-sites/AppSitePanel";
import { createDesktopSiteClient } from "./site-client";
import { Button, Dialog } from "../../design/primitives";
import { useConnection } from "../../stores/connection";
import { useUi } from "../../stores/ui";

export function DesktopAppSiteButton({ appSlug }: { appSlug: string }) {
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
  return <>
    <Button variant="subtle" disabled={!client} onClick={() => setOpen(true)}>Publish app</Button>
    <Dialog open={open} onClose={() => setOpen(false)} title="Publish app" width={640} placement="center"><div className="max-h-[80vh] space-y-4 overflow-y-auto p-6"><div className="flex items-center justify-between"><h2 className="font-semibold">Publish app</h2><Button variant="ghost" onClick={() => setOpen(false)}>Close</Button></div>{open && client ? <AppSitePanel key={`${runtimeSlot}:${authGeneration}:${appSlug}`} appSlug={appSlug} client={client} /> : null}</div></Dialog>
  </>;
}
