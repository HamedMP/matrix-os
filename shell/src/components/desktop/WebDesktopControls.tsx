"use client";

import Link from "next/link";
import { DiscordIcon, MessageCircleIcon, SearchIcon, ServerIcon } from "@/lib/hugeicons";
import { UserButton } from "../UserButton";
import { GettingStartedPopover } from "../onboarding/GettingStartedPopover";

export type WebDesktopSettingsSection = "appearance" | "billing" | "integrations" | "agents-providers";

interface WebDesktopControlsProps {
  onOpenSettings: (section: WebDesktopSettingsSection) => void;
  onOpenCommandPalette: () => void;
  onOpenSupport: () => void;
  onOpenFirstWork: () => void;
}

const actionClass =
  "flex size-7 items-center justify-center rounded-full border border-border/60 bg-card text-muted-foreground shadow-sm transition-colors hover:bg-muted/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** Web-safe equivalents of the native Desktop titlebar controls. */
export function WebDesktopControls({ onOpenSettings, onOpenCommandPalette, onOpenSupport, onOpenFirstWork }: WebDesktopControlsProps) {
  return (
    <nav aria-label="Desktop controls" className="flex items-center gap-1.5">
      <button
        type="button"
        aria-label="Search"
        title="Search (Cmd+K)"
        className={actionClass}
        onClick={onOpenCommandPalette}
      >
        <SearchIcon className="size-3.5" aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-label="Support chat"
        title="Support chat"
        className={actionClass}
        onClick={onOpenSupport}
      >
        <MessageCircleIcon className="size-3.5" aria-hidden="true" />
      </button>
      <a
        href="https://discord.gg/WHbvTG33w"
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Join Discord"
        title="Join Discord"
        className={actionClass}
      >
        <DiscordIcon className="size-3.5" aria-hidden="true" />
      </a>
      <Link
        href="/runtime"
        aria-label="Switch computer"
        title="Switch computer"
        className={actionClass}
      >
        <ServerIcon className="size-3.5" aria-hidden="true" />
      </Link>
      <GettingStartedPopover
        onOpenSettings={onOpenSettings}
        onOpenFirstWork={onOpenFirstWork}
        triggerClassName={actionClass}
      />
      <UserButton variant="menubar" onOpenSettings={onOpenSettings} />
    </nav>
  );
}
