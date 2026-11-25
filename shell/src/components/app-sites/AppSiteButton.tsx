"use client";
import { useState, type RefObject } from "react";
import { SharePanel, ShareTriggerLabel, createSiteEmailInvitationAdapter, useShareController } from "@matrix-os/ui/share";
import { SHELL_Z_INDEX } from "../../lib/shell-layering";
import { Button } from "../ui/button";
import { AppSiteSharePopover } from "./AppSiteSharePopover";
import { useAppSiteOwnerIdentity } from "./AppSiteOwnerIdentity";
import { webSiteClient } from "./web-site-client";
import { appDisplayName, ownerInitial } from "./share-identity";
import { useWebShareOrganization } from "./use-web-share-organization";
import { SiteSubmissionsSection } from "./SiteSubmissionsSection";

const emailInvites = createSiteEmailInvitationAdapter(webSiteClient);

export function AppSiteButton({
  appSlug,
  appName,
  portalContainer,
  portalContainerRef,
}: {
  appSlug: string;
  appName?: string;
  portalContainer?: HTMLElement | null;
  portalContainerRef?: RefObject<HTMLElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const ownerIdentity = useAppSiteOwnerIdentity();
  const name = appDisplayName(appSlug, appName);
  const share = useShareController({ appSlug, appName: name, client: webSiteClient, emailInvites });
  const organization = useWebShareOrganization(appSlug, name);
  const [resolvedPortalContainer, setResolvedPortalContainer] = useState<HTMLElement | null>(portalContainer ?? null);
  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      setResolvedPortalContainer(portalContainerRef?.current ?? portalContainer ?? null);
      // Re-read on open so changes from another window or device are not stale.
      share.refresh();
    }
    setOpen(nextOpen);
  };
  return (
    <AppSiteSharePopover
      open={open}
      onOpenChange={handleOpenChange}
      portalContainer={resolvedPortalContainer}
      zIndex={SHELL_Z_INDEX.appDialog}
      trigger={(
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 border-border bg-background px-2.5 text-xs text-foreground shadow-sm hover:bg-accent hover:text-accent-foreground"
        >
          <ShareTriggerLabel pageMode={share.pageMode} orgShared={organization.shared} />
        </Button>
      )}
    >
      {open ? (
        <SharePanel
          key={appSlug}
          share={share}
          appSlug={appSlug}
          appName={name}
          client={webSiteClient}
          ownerInitial={ownerInitial(ownerIdentity)}
          onClose={() => setOpen(false)}
          organization={organization.slot}
          // Shown for apps with forms, or while responses saved by an earlier version remain.
          submissions={share.site
            ? <SiteSubmissionsSection appSlug={appSlug} client={webSiteClient} formsDeclared={share.site.config.forms.length > 0} /> : null}
        />
      ) : null}
    </AppSiteSharePopover>
  );
}
