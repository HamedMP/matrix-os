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

  return (
    <div className="relative rounded-2xl overflow-hidden mb-6">
      <button
        onClick={() => onSelect(entry)}
        className="w-full text-left"
      >
        <div
          className="relative px-6 py-8 md:py-10"
          style={{
            background: `linear-gradient(135deg, ${entry.iconColor ?? "#3b82f6"}dd, ${entry.iconColor ?? "#3b82f6"}88)`,
          }}
        >
          <div className="flex items-center gap-5">
            <div
              className="flex size-16 md:size-20 shrink-0 items-center justify-center rounded-2xl text-2xl md:text-3xl shadow-lg bg-white/20 backdrop-blur-sm"
            >
              <span className="text-white font-bold">{entry.icon ?? entry.name.charAt(0)}</span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-white/70 uppercase tracking-wide mb-1">
                Featured
              </p>
              <h3 className="text-xl md:text-2xl font-bold text-white truncate">
                {entry.name}
              </h3>
              <p className="text-sm text-white/80 mt-1 line-clamp-2">
                {entry.featuredTagline ?? entry.description}
              </p>
            </div>
            <Button
              size="sm"
              variant="secondary"
              className="shrink-0 rounded-full h-8 px-4 text-xs font-semibold"
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
      </button>

      {entries.length > 1 && (
        <>
          <button
            onClick={prev}
            className="absolute left-2 top-1/2 -translate-y-1/2 size-8 flex items-center justify-center rounded-full bg-black/20 text-white/80 hover:bg-black/40 transition-colors"
          >
            <ChevronLeftIcon className="size-4" />
          </button>
          <button
            onClick={next}
            className="absolute right-2 top-1/2 -translate-y-1/2 size-8 flex items-center justify-center rounded-full bg-black/20 text-white/80 hover:bg-black/40 transition-colors"
          >
            <ChevronRightIcon className="size-4" />
          </button>

          <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex gap-1.5">
            {entries.map((_, i) => (
              <button
                key={i}
                onClick={() => setCurrent(i)}
                className={`size-1.5 rounded-full transition-colors ${
                  i === current ? "bg-white" : "bg-white/40"
                }`}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
