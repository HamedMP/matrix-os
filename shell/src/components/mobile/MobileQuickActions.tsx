"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import { LayersIcon, SettingsIcon, XCircleIcon, type LucideIcon } from "lucide-react";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";

interface MobileQuickActionsProps {
  openStackCount: number;
  onOpenSettings: () => void;
  onShowSwitcher: () => void;
  onCloseAll: () => void;
}

/**
 * Launcher quick-actions menu rendered as a brand-themed Base UI bottom-sheet
 * (drag handle, snap-to-dismiss). Establishes the mobile bottom-sheet pattern
 * for the shell. Each action closes the sheet before invoking its handler.
 */
export function MobileQuickActions({
  openStackCount,
  onOpenSettings,
  onShowSwitcher,
  onCloseAll,
}: MobileQuickActionsProps) {
  const [open, setOpen] = useState(false);
  const hasOpenApps = openStackCount > 0;

  const run = (action: () => void) => {
    setOpen(false);
    action();
  };

  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger
        render={
          <button
            type="button"
            aria-label="Quick actions"
            className="inline-flex size-9 items-center justify-center rounded-full border border-[var(--surface-glass-border)] bg-[color-mix(in_srgb,var(--foreground)_6%,transparent)] text-foreground transition-transform duration-150 ease-[var(--ease-emphasized)] active:scale-90"
          />
        }
      >
        <SettingsIcon className="size-4" />
      </DrawerTrigger>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Quick actions</DrawerTitle>
        </DrawerHeader>
        <div className="flex flex-col gap-1.5 px-4 pb-2">
          <ActionRow
            icon={SettingsIcon}
            label="Settings"
            onClick={() => run(onOpenSettings)}
          />
          {hasOpenApps && (
            <ActionRow
              icon={LayersIcon}
              label="App switcher"
              detail={`${openStackCount} open`}
              onClick={() => run(onShowSwitcher)}
            />
          )}
          {hasOpenApps && (
            <ActionRow
              icon={XCircleIcon}
              label="Close all apps"
              destructive
              onClick={() => run(onCloseAll)}
            />
          )}
        </div>
        <div className="px-4 pb-4 pt-1">
          <DrawerClose
            render={
              <button
                type="button"
                className="w-full rounded-xl border border-[var(--surface-glass-border)] bg-[color-mix(in_srgb,var(--foreground)_6%,transparent)] py-3 text-sm font-medium text-foreground transition-transform duration-150 ease-[var(--ease-emphasized)] active:scale-[0.98]"
              />
            }
          >
            Cancel
          </DrawerClose>
        </div>
      </DrawerContent>
    </Drawer>
  );
}

function ActionRow({
  icon: Icon,
  label,
  detail,
  destructive,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  detail?: string;
  destructive?: boolean;
  onClick: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-sm transition-colors active:bg-[color-mix(in_srgb,var(--foreground)_8%,transparent)] ${
        destructive ? "text-destructive" : "text-foreground"
      }`}
    >
      <Icon className="size-5 shrink-0 opacity-80" />
      <span className="flex-1 font-medium">{label}</span>
      {detail && <span className="text-xs text-muted-foreground">{detail}</span>}
    </button>
  );
}
