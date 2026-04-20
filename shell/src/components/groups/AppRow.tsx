"use client";

import { PackageIcon, XIcon } from "lucide-react";

interface SharedApp {
  slug: string;
  name: string;
  entry: string;
}

interface AppRowProps {
  app: SharedApp;
  isOwner: boolean;
  onUnshare: () => void;
}

export function AppRow({ app, isOwner, onUnshare }: AppRowProps) {
  return (
    <div
      data-testid={`app-row-${app.slug}`}
      className="flex items-center justify-between py-2 px-2 rounded-lg hover:bg-foreground/5 group"
    >
      <div className="flex items-center gap-2.5 min-w-0">
        <div className="size-8 rounded-lg bg-foreground/5 flex items-center justify-center shrink-0">
          <PackageIcon className="size-4 text-foreground/40" />
        </div>
        <span className="text-sm truncate">{app.name}</span>
      </div>
      {isOwner && (
        <button
          data-testid={`app-unshare-${app.slug}`}
          onClick={onUnshare}
          className="p-1 rounded text-foreground/30 hover:text-destructive hover:bg-destructive/10 opacity-0 group-hover:opacity-100 transition-opacity"
          title="Unshare"
        >
          <XIcon className="size-3.5" />
        </button>
      )}
    </div>
  );
}
