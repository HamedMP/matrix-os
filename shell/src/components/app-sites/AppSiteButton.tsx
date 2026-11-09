"use client";
import { useState, type RefObject } from "react";
import { SHELL_Z_INDEX } from "../../lib/shell-layering";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "../ui/dialog";
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
  const [resolvedPortalContainer, setResolvedPortalContainer] = useState<HTMLElement | null>(portalContainer ?? null);
  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) setResolvedPortalContainer(portalContainerRef?.current ?? portalContainer ?? null);
    setOpen(nextOpen);
  };
  return (
    <Dialog modal={false} open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          className="h-7 border-border bg-background px-2.5 text-xs text-foreground shadow-sm hover:bg-accent hover:text-accent-foreground"
        >
          Publish app
        </Button>
      </DialogTrigger>
      <DialogContent
        portalContainer={resolvedPortalContainer}
        showCloseButton={false}
        style={{ zIndex: SHELL_Z_INDEX.appDialog }}
        overlayStyle={{ background: "rgba(0, 0, 0, 0.72)" }}
        className="max-h-[calc(100%-2rem)] gap-0 overflow-hidden border-[#323238] bg-[#111113] p-0 text-[#f4f4f5] sm:max-w-xl"
      >
        <DialogTitle className="sr-only">Share app</DialogTitle>
        <DialogDescription className="sr-only">
          Publish your app and manage access, links, versions, and visitor responses.
        </DialogDescription>
        {open ? (
          <AppSiteSharePanel
            key={appSlug}
            appSlug={appSlug}
            client={webSiteClient}
            onClose={() => setOpen(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
