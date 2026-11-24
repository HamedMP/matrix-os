"use client";

import { Button } from "@/components/ui/button";
import { MessageCircleIcon } from "@/lib/hugeicons";
import { openShellSupport } from "@/lib/posthog-client";

export function MobileShellHeader({ time, title, onOpenCommandPalette }: {
  time: string;
  title: string;
  onOpenCommandPalette?: () => void;
}) {
  return (
    <header className="flex h-7 shrink-0 items-center justify-between px-4 text-xs text-muted-foreground">
      <span data-testid="mobile-shell-clock" className="font-semibold">{time}</span>
      <span className="truncate px-2 opacity-70">{title}</span>
      <div className="flex shrink-0 items-center gap-1">
        <Button type="button" variant="ghost" size="icon" className="size-6"
          aria-label="Support" onClick={() => { void openShellSupport(); }}>
          <MessageCircleIcon className="size-3.5" />
        </Button>
        <Button type="button" variant="ghost" size="icon" className="size-6 text-base"
          aria-label="Command palette" onClick={onOpenCommandPalette}>⌘</Button>
      </div>
    </header>
  );
}
