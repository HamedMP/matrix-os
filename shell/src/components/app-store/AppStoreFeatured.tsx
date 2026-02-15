"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { ChevronLeftIcon, ChevronRightIcon, DownloadIcon } from "lucide-react";
import type { AppStoreEntry } from "@/stores/app-store";

interface AppStoreFeaturedProps {
  entries: AppStoreEntry[];
  onSelect: (entry: AppStoreEntry) => void;
  onInstall: (entry: AppStoreEntry) => void;
}

export function AppStoreFeatured({ entries, onSelect, onInstall }: AppStoreFeaturedProps) {
  const [current, setCurrent] = useState(0);

  const next = useCallback(() => {
    setCurrent((i) => (i + 1) % entries.length);
  }, [entries.length]);

  const prev = useCallback(() => {
    setCurrent((i) => (i - 1 + entries.length) % entries.length);
  }, [entries.length]);

  useEffect(() => {
    if (entries.length <= 1) return;
    const timer = setInterval(next, 5000);
    return () => clearInterval(timer);
  }, [entries.length, next]);

  if (entries.length === 0) return null;

  const entry = entries[current];
  const color = entry.iconColor ?? "#3b82f6";

  return (
    <div className="mb-8">
      {/* Navigation header */}
      {entries.length > 1 && (
        <div className="flex items-center justify-end gap-1 mb-2 pr-1">
          <button
            onClick={prev}
            className="size-7 flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <ChevronLeftIcon className="size-4" />
          </button>
          <button
            onClick={next}
            className="size-7 flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <ChevronRightIcon className="size-4" />
          </button>
        </div>
      )}

      {/* Card */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => onSelect(entry)}
        onKeyDown={(e) => { if (e.key === "Enter") onSelect(entry); }}
        className="rounded-2xl overflow-hidden cursor-pointer shadow-sm hover:shadow-md transition-shadow max-w-2xl"
      >
        <div
          className="px-5 py-5"
          style={{
            background: `linear-gradient(145deg, ${color}18, ${color}30)`,
          }}
        >
          <p className="text-[11px] font-semibold uppercase tracking-wider mb-3"
            style={{ color }}
          >
            Featured
          </p>

          <div className="flex items-center gap-4">
            <div
              className="flex size-14 shrink-0 items-center justify-center rounded-[14px] text-xl shadow-sm"
              style={{ backgroundColor: color }}
            >
              <span className="text-white font-bold">
                {entry.icon ?? entry.name.charAt(0)}
              </span>
            </div>

            <div className="flex-1 min-w-0">
              <h3 className="text-base font-bold truncate">{entry.name}</h3>
              <p className="text-[13px] text-muted-foreground mt-0.5 line-clamp-1">
                {entry.featuredTagline ?? entry.description}
              </p>
            </div>

            <Button
              size="sm"
              variant="default"
              className="shrink-0 rounded-full h-8 px-5 text-xs font-semibold"
              onClick={(e) => {
                e.stopPropagation();
                onInstall(entry);
              }}
            >
              {entry.source === "bundled" ? "Open" : (
                <>
                  <DownloadIcon className="size-3 mr-1" />
                  Get
                </>
              )}
            </Button>
          </div>
        </div>
      </div>

      {/* Dots */}
      {entries.length > 1 && (
        <div className="flex justify-center gap-1.5 mt-3">
          {entries.map((_, i) => (
            <button
              key={i}
              onClick={() => setCurrent(i)}
              className={`rounded-full transition-all ${
                i === current
                  ? "w-4 h-1.5 bg-primary"
                  : "size-1.5 bg-border hover:bg-muted-foreground/50"
              }`}
            />
          ))}
        </div>
      )}
    </div>
  );
}
