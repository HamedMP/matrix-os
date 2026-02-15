"use client";

import { Button } from "@/components/ui/button";
import { StarRating } from "./StarRating";
import { SparklesIcon, DownloadIcon } from "lucide-react";
import type { AppStoreEntry } from "@/stores/app-store";

function formatDownloads(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K`;
  return String(n);
}

interface AppCardProps {
  entry: AppStoreEntry;
  installed: boolean;
  onSelect: () => void;
  onInstall: () => void;
}

export function AppCard({ entry, installed, onSelect, onInstall }: AppCardProps) {
  const isBundled = entry.source === "bundled";
  const showOpen = isBundled || installed;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => { if (e.key === "Enter") onSelect(); }}
      className="flex items-center gap-3 rounded-xl p-3 text-left hover:bg-muted/50 transition-colors w-full group cursor-pointer"
    >
      <div
        className="flex size-12 shrink-0 items-center justify-center rounded-xl text-lg shadow-sm"
        style={{ backgroundColor: entry.iconColor ?? "#6b7280" }}
      >
        <span className="text-white font-semibold">{entry.icon ?? entry.name.charAt(0)}</span>
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium truncate">{entry.name}</span>
          {entry.source === "prompt" && !installed && (
            <SparklesIcon className="size-3 text-amber-500 shrink-0" />
          )}
          {entry.new && (
            <span className="text-[9px] font-semibold text-blue-500 uppercase">New</span>
          )}
        </div>
        <p className="text-xs text-muted-foreground truncate">{entry.category}</p>
        <div className="flex items-center gap-2 mt-0.5">
          {entry.rating !== undefined && (
            <StarRating rating={entry.rating} />
          )}
          {entry.downloads !== undefined && (
            <span className="text-[10px] text-muted-foreground">
              {formatDownloads(entry.downloads)}
            </span>
          )}
        </div>
      </div>

      <Button
        size="sm"
        variant={showOpen ? "outline" : "default"}
        className="h-7 min-w-[60px] text-xs shrink-0 rounded-full"
        onClick={(e) => {
          e.stopPropagation();
          onInstall();
        }}
      >
        {showOpen ? (
          "Open"
        ) : (
          <>
            <DownloadIcon className="size-3 mr-1" />
            Get
          </>
        )}
      </Button>
    </div>
  );
}
