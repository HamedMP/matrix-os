import { useEffect, useMemo, useState } from "react";
import { AppSiteSharePopover } from "../../../../../../shell/src/components/app-sites/AppSiteSharePopover";
import { appDisplayName, ownerInitial } from "../../../../../../shell/src/components/app-sites/share-identity";
import { SiteSubmissionsSection } from "../../../../../../shell/src/components/app-sites/SiteSubmissionsSection";
import { SharePanel, ShareTriggerLabel, createSiteEmailInvitationAdapter, useShareController, SocialPreviewSection } from "@matrix-os/ui/share";
import { createDesktopSiteClient } from "./site-client";
import { DESKTOP_Z_INDEX } from "../../design/layering";
import { Button } from "../../design/primitives";
import { useConnection } from "../../stores/connection";
import { useUi } from "../../stores/ui";
import { useDesktopShareOrganization } from "./use-desktop-share-organization";

export function DesktopAppSiteButton({
  appSlug,
  appName,
  portalContainer,
  buildEpoch = 0,
}: {
  appSlug: string;
  appName?: string;
  portalContainer?: HTMLElement | null;
  buildEpoch?: number;
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
  const emailInvites = useMemo(() => client ? createSiteEmailInvitationAdapter(client) : null, [client]);
  const collaborationApi = useMemo(() => api?.forRuntime(runtimeSlot) ?? null,
    [api, runtimeSlot, authGeneration]);
  const name = appDisplayName(appSlug, appName);
  const share = useShareController({ appSlug, appName: name, client, emailInvites });
  const organization = useDesktopShareOrganization({ appSlug, appName: name, api: collaborationApi, buildEpoch });
  return (
    <AppSiteSharePopover
      onOpenChange={(next) => { if (next) share.refresh(); setOpen(next); }}
      portalContainer={portalContainer}
      trigger={(
        <Button
          variant="subtle"
          disabled={!client}
          style={{ height: 28, padding: "0 10px", gap: 6, fontSize: 12, background: "var(--bg-app)", color: "var(--text-primary)", border: "1px solid var(--border-default)", boxShadow: "var(--shadow-1)" }}
        >
          <ShareTriggerLabel pageMode={share.pageMode} orgShared={organization.shared} />
        </Button>
      )}
      open={open}
      zIndex={DESKTOP_Z_INDEX.popover}
    >
      {open && client ? (
        <SharePanel
          key={`${runtimeSlot}:${authGeneration}:${appSlug}`}
          share={share}
          appSlug={appSlug}
          appName={name}
          client={client}
          ownerInitial={ownerInitial(email ?? userId)}
          onClose={() => setOpen(false)}
          organization={organization.slot}
          submissions={share.site
            ? <><SocialPreviewSection appSlug={appSlug} client={client} site={share.site} /><SiteSubmissionsSection appSlug={appSlug} client={client} formsDeclared={share.site.config.forms.length > 0} /></> : null}
        />
      ) : null}
    </AppSiteSharePopover>
  );
}
