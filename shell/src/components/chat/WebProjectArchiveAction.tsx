"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";

export function WebProjectArchiveAction({ projectId, projectSlug, projectName, onArchive }: {
  projectId: string;
  projectSlug: string;
  projectName: string;
  onArchive(projectId: string, projectSlug: string, projectName: string): Promise<boolean>;
}) {
  const [confirm, setConfirm] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  return <div className="px-2 pb-1 text-xs">
    <Button type="button" variant="ghost" size="sm" className="h-auto px-0 text-muted-foreground" onClick={() => setConfirm(true)}>Archive chats in {projectName}</Button>
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
  </div>;
}
