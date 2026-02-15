"use client";

import { Button } from "@/components/ui/button";
import { StarRating } from "./StarRating";
import { XIcon, DownloadIcon, SparklesIcon } from "lucide-react";
import type { AppStoreEntry } from "@/stores/app-store";

function formatDownloads(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K`;
  return String(n);
}

interface AppDetailProps {
  entry: AppStoreEntry;
  installed: boolean;
  onClose: () => void;
  onInstall: () => void;
}

export function AppDetail({ entry, installed, onClose, onInstall }: AppDetailProps) {
  const isBundled = entry.source === "bundled";
  const showOpen = isBundled || installed;

  return (
    <div className="w-[380px] h-full bg-card border-l border-border flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <h3 className="text-sm font-semibold">App Info</h3>
        <button
          onClick={onClose}
          className="size-7 flex items-center justify-center rounded-md hover:bg-muted transition-colors"
        >
          <XIcon className="size-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="p-5 flex flex-col items-center text-center border-b border-border">
          <div
            className="flex size-20 items-center justify-center rounded-[20px] text-3xl shadow-lg mb-4"
            style={{ backgroundColor: entry.iconColor ?? "#6b7280" }}
          >
            <span className="text-white font-bold">{entry.icon ?? entry.name.charAt(0)}</span>
          </div>

          <h2 className="text-lg font-bold">{entry.name}</h2>
          <p className="text-xs text-muted-foreground mt-0.5">{entry.category}</p>

          {entry.rating !== undefined && (
            <div className="mt-2">
              <StarRating rating={entry.rating} count={entry.ratingCount} size="md" />
            </div>
          )}

          <div className="flex items-center gap-1 mt-3">
            {entry.source === "prompt" && !installed && (
              <div className="flex items-center gap-1 text-[10px] text-amber-500">
                <SparklesIcon className="size-3" />
                <span>AI-generated on install</span>
              </div>
            )}
          </div>

          <Button
            className="mt-4 w-full max-w-[200px] rounded-full"
            variant={showOpen ? "outline" : "default"}
            onClick={onInstall}
          >
            {showOpen ? (
              "Open"
            ) : (
              <>
                <DownloadIcon className="size-4 mr-2" />
                Get
              </>
            )}
          </Button>
        </div>

        <div className="p-5 space-y-4">
          <div>
            <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
              Description
            </h4>
            <p className="text-sm leading-relaxed">
              {entry.longDescription ?? entry.description}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <InfoItem label="Author" value={entry.author} />
            <InfoItem label="Source" value={entry.source} />
            {entry.version && <InfoItem label="Version" value={entry.version} />}
            {entry.downloads !== undefined && (
              <InfoItem label="Downloads" value={formatDownloads(entry.downloads)} />
            )}
          </div>

          {entry.tags && entry.tags.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                Tags
              </h4>
              <div className="flex flex-wrap gap-1.5">
                {entry.tags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded-full bg-muted px-2.5 py-0.5 text-[10px] text-muted-foreground"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function InfoItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</p>
      <p className="text-xs font-medium mt-0.5 capitalize">{value}</p>
    </div>
  );
}
