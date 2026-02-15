"use client";

import { useRef } from "react";
import { AppCard } from "./AppCard";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import type { AppStoreEntry } from "@/stores/app-store";

interface AppStoreSectionProps {
  title: string;
  entries: AppStoreEntry[];
  installedIds: Set<string>;
  onSelect: (entry: AppStoreEntry) => void;
  onInstall: (entry: AppStoreEntry) => void;
}

export function AppStoreSection({
  title,
  entries,
  installedIds,
  onSelect,
  onInstall,
}: AppStoreSectionProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  if (entries.length === 0) return null;

  function scroll(dir: number) {
    scrollRef.current?.scrollBy({ left: dir * 300, behavior: "smooth" });
  }

  return (
    <section className="mb-6">
      <div className="flex items-center justify-between mb-2 px-1">
        <h3 className="text-sm font-semibold">{title}</h3>
        <div className="flex gap-1">
          <button
            onClick={() => scroll(-1)}
            className="size-6 flex items-center justify-center rounded-md hover:bg-muted transition-colors text-muted-foreground"
          >
            <ChevronLeftIcon className="size-3.5" />
          </button>
          <button
            onClick={() => scroll(1)}
            className="size-6 flex items-center justify-center rounded-md hover:bg-muted transition-colors text-muted-foreground"
          >
            <ChevronRightIcon className="size-3.5" />
          </button>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="flex gap-1 overflow-x-auto scrollbar-hide pb-1"
      >
        {entries.map((entry) => (
          <div key={entry.id} className="min-w-[280px] max-w-[320px] shrink-0">
            <AppCard
              entry={entry}
              installed={installedIds.has(entry.id)}
              onSelect={() => onSelect(entry)}
              onInstall={() => onInstall(entry)}
            />
          </div>
        ))}
      </div>
    </section>
  );
}
