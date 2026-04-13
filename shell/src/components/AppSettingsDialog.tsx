"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TerminalSettingsPanel } from "./terminal/TerminalMenuBarControls";

const FALLBACK_APP_ICON = "/icon-192.png";

function getBaseAppPath(path: string | null | undefined): string | null {
  if (!path) {
    return null;
  }
  if (path.startsWith("__") && path.includes(":")) {
    return path.split(":")[0] ?? path;
  }
  return path;
}

interface AppSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appName: string;
  appPath?: string | null;
  iconUrl?: string | null;
}

export function AppSettingsDialog({
  open,
  onOpenChange,
  appName,
  appPath,
  iconUrl,
}: AppSettingsDialogProps) {
  const basePath = getBaseAppPath(appPath);
  const hasCustomSettings = basePath === "__terminal__";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <img
              key={iconUrl ?? FALLBACK_APP_ICON}
              src={iconUrl ?? FALLBACK_APP_ICON}
              alt=""
              className="size-10 rounded-xl border border-border/40 bg-background object-cover p-1"
              onError={(event) => {
                const img = event.currentTarget;
                img.onerror = null;
                img.src = FALLBACK_APP_ICON;
              }}
            />
            <div className="space-y-1">
              <DialogTitle>{appName} Settings</DialogTitle>
              <DialogDescription>
                {hasCustomSettings
                  ? `These preferences apply to ${appName} anywhere it appears in Matrix.`
                  : `App-specific settings will appear here when ${appName} defines them.`}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {hasCustomSettings ? (
          <TerminalSettingsPanel />
        ) : (
          <div className="rounded-2xl border border-dashed border-border/60 bg-muted/20 px-4 py-5">
            <p className="text-sm text-foreground/85">
              No custom settings are registered for this app yet.
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              The menu bar wiring is in place, so new apps can expose preferences here without
              changing the overall shell pattern.
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
