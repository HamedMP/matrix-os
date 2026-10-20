"use client";
import { useState } from "react";
import { SHELL_Z_INDEX } from "../../lib/shell-layering";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "../ui/dialog";
import { AppSitePanel } from "./AppSitePanel";
import { webSiteClient } from "./web-site-client";
export function AppSiteButton({ appSlug }: { appSlug: string }) {
  const [open, setOpen] = useState(false);
  return <Dialog modal={false} open={open} onOpenChange={setOpen}>
    <DialogTrigger asChild><Button size="sm" variant="outline">Publish app</Button></DialogTrigger>
    <DialogContent style={{ zIndex: SHELL_Z_INDEX.appDialog }} className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>Publish app</DialogTitle><DialogDescription>Deploy your app and manage visitor responses.</DialogDescription></DialogHeader>{open ? <AppSitePanel key={appSlug} appSlug={appSlug} client={webSiteClient} /> : null}</DialogContent>
  </Dialog>;
}
