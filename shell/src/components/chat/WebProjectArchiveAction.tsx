"use client";

import { useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Archive, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";

export function WebProjectArchiveAction({ projectId, projectSlug, projectName, onArchive }: {
  projectId: string;
  projectSlug: string;
  projectName: string;
  onArchive(projectId: string, projectSlug: string, projectName: string): Promise<boolean>;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  return <><DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen}><DropdownMenu.Trigger asChild>
    <button type="button" aria-label={`Actions for ${projectName}`} className="matrix-web-project-actions grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent" onClick={() => setMenuOpen(true)}><MoreHorizontal size={15} aria-hidden/></button>
    </DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content align="end" sideOffset={4} className="min-w-52 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg" style={{zIndex:SHELL_Z_INDEX.appDialog}}><DropdownMenu.Item aria-label={`Archive chats in ${projectName}`} className="flex cursor-default items-center gap-2 rounded px-2.5 py-1.5 text-sm outline-none data-[highlighted]:bg-accent" onSelect={() => setConfirm(true)}><Archive size={14} aria-hidden/>Archive chats</DropdownMenu.Item></DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>
    <Dialog open={confirm} onOpenChange={open => { if (!open && !pending) { setConfirm(false); setError(false); } }}>
      <DialogContent role="alertdialog" aria-label={`Archive chats in ${projectName}?`} showCloseButton={false} className="sm:max-w-[400px]"
        style={{ zIndex: SHELL_Z_INDEX.appDialog }} overlayStyle={{ zIndex: SHELL_Z_INDEX.appDialog }}>
        <DialogHeader><DialogTitle>Archive chats in {projectName}?</DialogTitle>
          <DialogDescription>Archive all idle chats in {projectName}? Running chats will be skipped.</DialogDescription></DialogHeader>
        {error ? <p role="alert" className="text-destructive">Project chats could not be archived. Try again.</p> : null}
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={pending} onClick={() => { setConfirm(false); setError(false); }}>Cancel</Button>
          <Button type="button" disabled={pending} onClick={() => {
            setPending(true);
            setError(false);
            void onArchive(projectId, projectSlug, projectName).then(done => { if (done) setConfirm(false); else setError(true); })
              .catch((cause: unknown) => { console.warn("[web-projects] Archive failed:", cause instanceof Error ? cause.name : "UnknownError"); setError(true); })
              .finally(() => setPending(false));
          }}>Archive chats</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
