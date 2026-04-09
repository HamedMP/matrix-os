"use client";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { MicIcon, MicOffIcon } from "lucide-react";
import type { MicPermissionState } from "@/hooks/useMicPermission";

interface MicPermissionDialogProps {
  open: boolean;
  permissionState: MicPermissionState;
  onAllow: () => void;
  onDismiss: () => void;
}

export function MicPermissionDialog({ open, permissionState, onAllow, onDismiss }: MicPermissionDialogProps) {
  if (permissionState === "denied") {
    return (
      <Dialog open={open} onOpenChange={(v) => !v && onDismiss()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <div className="flex items-center gap-3">
              <div className="size-10 rounded-full bg-destructive/10 flex items-center justify-center">
                <MicOffIcon className="size-5 text-destructive" />
              </div>
              <DialogTitle>Microphone Blocked</DialogTitle>
            </div>
            <DialogDescription className="pt-2">
              Microphone access was blocked. To enable it, click the lock icon in your browser's address bar, allow microphone access, then reload the page.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={onDismiss}>Got it</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onDismiss()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="size-10 rounded-full bg-primary/10 flex items-center justify-center">
              <MicIcon className="size-5 text-primary" />
            </div>
            <DialogTitle>Enable Microphone</DialogTitle>
          </div>
          <DialogDescription className="pt-2">
            Matrix OS uses your microphone for voice conversations with the AI. Audio is processed in real-time and not stored.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="ghost" onClick={onDismiss}>Not Now</Button>
          <Button onClick={onAllow}>Allow Microphone</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
