"use client";
import { useState } from "react";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { AppSitePanel } from "./AppSitePanel";
import { webSiteClient } from "./web-site-client";
export function AppSiteButton({ appSlug }: { appSlug: string }) {
  const [open, setOpen] = useState(false);
  return <>
    <Button size="sm" variant="outline" onClick={() => setOpen(true)}>Publish app</Button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>Publish app</DialogTitle><DialogDescription>Deploy your app and manage visitor responses.</DialogDescription></DialogHeader>{open ? <AppSitePanel key={appSlug} appSlug={appSlug} client={webSiteClient} /> : null}</DialogContent></Dialog>
  </>;
}
