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

function darken(hex: string, amount: number): string {
  const n = parseInt(hex.replace("#", ""), 16);
  const r = Math.max(0, ((n >> 16) & 0xff) - amount);
  const g = Math.max(0, ((n >> 8) & 0xff) - amount);
  const b = Math.max(0, (n & 0xff) - amount);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

export function AppStoreFeatured({ entries, onSelect, onInstall }: AppStoreFeaturedProps) {
  const [current, setCurrent] = useState(0);
  const [hovering, setHovering] = useState(false);

  const next = useCallback(() => {
    setCurrent((i) => (i + 1) % entries.length);
  }, [entries.length]);

  const prev = useCallback(() => {
    setCurrent((i) => (i - 1 + entries.length) % entries.length);
  }, [entries.length]);

  useEffect(() => {
    if (entries.length <= 1 || hovering) return;
    const timer = setInterval(next, 5000);
    return () => clearInterval(timer);
  }, [entries.length, next, hovering]);

  if (entries.length === 0) return null;

  const entry = entries[current];
  const color = entry.iconColor ?? "#3b82f6";
  const dark = darken(color, 40);

  return (
    <div className="mb-8">
      <div
        className="relative rounded-2xl overflow-hidden group"
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
      >
        <div
          role="button"
          tabIndex={0}
          onClick={() => onSelect(entry)}
          onKeyDown={(e) => { if (e.key === "Enter") onSelect(entry); }}
          className="cursor-pointer"
        >
          <div
            className="relative px-8 py-8 md:px-10 md:py-10"
            style={{
              background: `linear-gradient(135deg, ${dark}, ${color})`,
            }}
          >
            <p className="text-[11px] font-semibold uppercase tracking-widest text-white/60 mb-4">
              Featured
            </p>

            <div className="flex items-center gap-5">
              <div
                className="flex size-16 md:size-[72px] shrink-0 items-center justify-center rounded-[18px] text-2xl md:text-3xl shadow-lg ring-1 ring-white/20"
                style={{ backgroundColor: "rgba(255,255,255,0.2)" }}
              >
                <span className="text-white font-bold drop-shadow-sm">
                  {entry.icon ?? entry.name.charAt(0)}
                </span>
              </div>

              <div className="flex-1 min-w-0">
                <h3 className="text-xl md:text-2xl font-bold text-white truncate">
                  {entry.name}
                </h3>
                <p className="text-sm text-white/70 mt-1 line-clamp-2">
                  {entry.featuredTagline ?? entry.description}
                </p>
              </div>

              <Button
                size="sm"
                className="shrink-0 rounded-full h-9 px-6 text-xs font-semibold bg-white/20 backdrop-blur-sm text-white border border-white/20 hover:bg-white/30"
                onClick={(e) => {
                  e.stopPropagation();
                  onInstall(entry);
                }}
              >
                {entry.source === "bundled" ? "Open" : (
                  <>
                    <DownloadIcon className="size-3 mr-1.5" />
                    Get
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>

        {/* Arrows -- visible on hover */}
        {entries.length > 1 && (
          <>
            <button
              onClick={prev}
              className="absolute left-3 top-1/2 -translate-y-1/2 size-9 flex items-center justify-center rounded-full bg-black/30 backdrop-blur-sm text-white/90 hover:bg-black/50 transition-all opacity-0 group-hover:opacity-100"
            >
              <ChevronLeftIcon className="size-5" />
            </button>
            <button
              onClick={next}
              className="absolute right-3 top-1/2 -translate-y-1/2 size-9 flex items-center justify-center rounded-full bg-black/30 backdrop-blur-sm text-white/90 hover:bg-black/50 transition-all opacity-0 group-hover:opacity-100"
            >
              <ChevronRightIcon className="size-5" />
            </button>
          </>
        )}

        {/* Dots */}
        {entries.length > 1 && (
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex gap-1.5">
            {entries.map((_, i) => (
              <button
                key={i}
                onClick={() => setCurrent(i)}
                className={`rounded-full transition-all ${
                  i === current
                    ? "w-5 h-1.5 bg-white"
                    : "size-1.5 bg-white/40 hover:bg-white/60"
                }`}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
