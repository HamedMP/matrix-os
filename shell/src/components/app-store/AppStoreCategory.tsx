"use client";

import { AppCard } from "./AppCard";
import { PackageIcon } from "lucide-react";
import type { AppStoreEntry } from "@/stores/app-store";

interface AppStoreCategoryProps {
  entries: AppStoreEntry[];
  installedIds: Set<string>;
  onSelect: (entry: AppStoreEntry) => void;
  onInstall: (entry: AppStoreEntry) => void;
}

export function AppStoreCategory({
  entries,
  installedIds,
  onSelect,
  onInstall,
}: AppStoreCategoryProps) {
  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
        <PackageIcon className="size-8 mb-3 opacity-30" />
        <p className="text-sm">No apps in this category</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-1">
      {entries.map((entry) => (
        <AppCard
          key={entry.id}
          entry={entry}
          installed={installedIds.has(entry.id)}
          onSelect={() => onSelect(entry)}
          onInstall={() => onInstall(entry)}
        />
      ))}
    </div>
  );
}
