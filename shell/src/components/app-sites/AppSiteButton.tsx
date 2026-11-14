"use client";
import { useEffect, useState, type RefObject } from "react";
import { SHELL_Z_INDEX } from "../../lib/shell-layering";
import { getGatewayUrl } from "../../lib/gateway";
import { cn } from "../../lib/utils";
import { useOwnerCollaborationParticipant } from "../../lib/owner-collaboration-participant";
import { subscribeOwnerAppSharing } from "../../lib/owner-app-sharing-events";
import { Button } from "../ui/button";
import { AppSiteSharePopover } from "./AppSiteSharePopover";
import { useAppSiteOwnerIdentity } from "./AppSiteOwnerIdentity";
import { WebAppOrgSharePanel } from "./WebAppOrgSharePanel";
import { webSiteClient } from "./web-site-client";

/** Rebuilds of the open app, reported by its viewer, so readiness is re-read while the popover is open. */
function useOwnerAppBuildEpoch(appSlug: string): number {
  const [epoch, setEpoch] = useState({ appSlug, value: 0 });
  useEffect(() => subscribeOwnerAppSharing(appSlug, "build-changed", () => {
    setEpoch((current) => ({ appSlug, value: current.appSlug === appSlug ? current.value + 1 : 1 }));
  }), [appSlug]);
  return epoch.appSlug === appSlug ? epoch.value : 0;
}

export function AppSiteButton({
  appSlug,
  portalContainer,
  portalContainerRef,
  triggerClassName,
}: {
  appSlug: string;
  portalContainer?: HTMLElement | null;
  portalContainerRef?: RefObject<HTMLElement | null>;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const ownerIdentity = useAppSiteOwnerIdentity();
  const participant = useOwnerCollaborationParticipant();
  const buildEpoch = useOwnerAppBuildEpoch(appSlug);
  const [resolvedPortalContainer, setResolvedPortalContainer] = useState<HTMLElement | null>(portalContainer ?? null);
  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) setResolvedPortalContainer(portalContainerRef?.current ?? portalContainer ?? null);
    setOpen(nextOpen);
  };
  // Sharing state belongs to one runtime, account, and app; any change starts a fresh read.
  const scope = `${getGatewayUrl()}:${participant?.actorId ?? ownerIdentity}:${appSlug}`;
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
          className={cn("h-7 border-border bg-background px-2.5 text-xs text-foreground shadow-sm hover:bg-accent hover:text-accent-foreground", triggerClassName)}
        >
          Publish app
        </Button>
      )}
    >
      {open ? (
        <WebAppOrgSharePanel
          key={scope}
          appSlug={appSlug}
          client={webSiteClient}
          ownerIdentity={ownerIdentity}
          buildEpoch={buildEpoch}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </AppSiteSharePopover>
  );
}
