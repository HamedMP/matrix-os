"use client";
import { useState, type RefObject } from "react";
import { SharePanel, ShareTriggerLabel, emailInvitesPreviewEnabled, previewEmailInvitationAdapter, useShareController } from "@matrix-os/ui/share";
import { SHELL_Z_INDEX } from "../../lib/shell-layering";
import { Button } from "../ui/button";
import { AppSiteSharePopover } from "./AppSiteSharePopover";
import { useAppSiteOwnerIdentity } from "./AppSiteOwnerIdentity";
import { webSiteClient } from "./web-site-client";
import { appDisplayName, ownerInitial } from "./share-identity";
import { useWebShareOrganization } from "./use-web-share-organization";

// TODO(2691): replace the preview adapter with the real site-client adapter once #3233–#3340 merge.
const emailInvites = previewEmailInvitationAdapter(emailInvitesPreviewEnabled(process.env.NEXT_PUBLIC_MATRIX_SHARE_EMAIL_INVITES_PREVIEW));

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
    if (nextOpen) setResolvedPortalContainer(portalContainerRef?.current ?? portalContainer ?? null);
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
        />
      ) : null}
    </AppSiteSharePopover>
  );
}
