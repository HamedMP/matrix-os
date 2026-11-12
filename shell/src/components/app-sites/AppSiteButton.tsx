"use client";
import { useState, type RefObject } from "react";
import { SHELL_Z_INDEX } from "../../lib/shell-layering";
import { Button } from "../ui/button";
import { AppSiteSharePopover } from "./AppSiteSharePopover";
import { useAppSiteOwnerIdentity } from "./AppSiteOwnerIdentity";
import { AppSiteSharePanel } from "./AppSiteSharePanel";
import { webSiteClient } from "./web-site-client";
export function AppSiteButton({
  appSlug,
  portalContainer,
  portalContainerRef,
}: {
  appSlug: string;
  portalContainer?: HTMLElement | null;
  portalContainerRef?: RefObject<HTMLElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const ownerIdentity = useAppSiteOwnerIdentity();
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
          className="h-7 border-border bg-background px-2.5 text-xs text-foreground shadow-sm hover:bg-accent hover:text-accent-foreground"
        >
          Publish app
        </Button>
      )}
    >
      {open ? (
        <AppSiteSharePanel
          key={appSlug}
          appSlug={appSlug}
          client={webSiteClient}
          ownerIdentity={ownerIdentity}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </AppSiteSharePopover>
  );
}
