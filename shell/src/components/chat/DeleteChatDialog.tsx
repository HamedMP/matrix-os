"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";

export interface DeleteChatTarget {
  id: string;
  title: string;
}

const DELETE_FAILED = "The Chat could not be deleted. Try again.";

/** Same copy and failure behavior as Electron's DeleteConversationDialog. */
export function DeleteChatDialog({ target, deleting, error, onCancel, onConfirm }: {
  target: DeleteChatTarget | null;
  deleting: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const title = target ? `Delete ${target.title}?` : "Delete chat?";
  return (
    <Dialog open={target !== null} onOpenChange={(open) => { if (!open && !deleting) onCancel(); }}>
      <DialogContent role="alertdialog" aria-label={title} showCloseButton={false} className="sm:max-w-[400px]"
        style={{ zIndex: SHELL_Z_INDEX.appDialog }} overlayStyle={{ zIndex: SHELL_Z_INDEX.appDialog }}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>This permanently deletes this chat and its messages. This action cannot be undone.</DialogDescription>
        </DialogHeader>
        {error ? <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={deleting} onClick={onCancel}>Cancel</Button>
          <Button type="button" variant="destructive" disabled={deleting} onClick={onConfirm}>{deleting ? "Deleting chat" : "Delete chat"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Dialog state for one pending deletion; failures keep the dialog open with fixed copy. */
export function useDeleteChatDialog(onDelete?: (id: string) => Promise<boolean>) {
  const [target, setTarget] = useState<DeleteChatTarget | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    setTarget(null);
    setError(null);
  };
  const confirm = () => {
    if (!onDelete || !target || deleting) return;
    setDeleting(true);
    setError(null);
    void onDelete(target.id).then((deleted) => {
      if (deleted) close();
      else setError(DELETE_FAILED);
    }).catch((failure: unknown) => {
      console.warn("[chat] Delete failed:", failure instanceof Error ? failure.name : "UnknownError");
      setError(DELETE_FAILED);
    }).finally(() => setDeleting(false));
  };
  return {
    open: onDelete ? (next: DeleteChatTarget) => { setError(null); setTarget(next); } : undefined,
    dialog: { target, deleting, error, onCancel: close, onConfirm: confirm },
  };
}
