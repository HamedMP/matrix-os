"use client";

import Link from "next/link";
import { CircleHelpIcon, ServerIcon } from "@/lib/hugeicons";
import { UserButton } from "../UserButton";

export type WebDesktopSettingsSection = "appearance" | "billing" | "plugins";

interface WebDesktopControlsProps {
  onOpenSettings: (section: WebDesktopSettingsSection) => void;
}

const actionClass =
  "flex size-7 items-center justify-center rounded-full border border-border/60 bg-card text-muted-foreground shadow-sm transition-colors hover:bg-muted/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** Web-safe equivalents of the native Desktop titlebar controls. */
export function WebDesktopControls({ onOpenSettings }: WebDesktopControlsProps) {
  return (
    <nav aria-label="Desktop controls" className="flex items-center gap-1.5">
      <Link
        href="/runtime"
        aria-label="Switch computer"
        title="Switch computer"
        className={actionClass}
      >
        <ServerIcon className="size-3.5" aria-hidden="true" />
      </Link>
      <a
        href="https://matrix-os.com/docs"
        target="_blank"
        rel="noreferrer"
        aria-label="Support"
        title="Support"
        className={actionClass}
      >
        <CircleHelpIcon className="size-3.5" aria-hidden="true" />
      </a>
      <UserButton variant="menubar" onOpenSettings={onOpenSettings} />
    </nav>
  );
}
