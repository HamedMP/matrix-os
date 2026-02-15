"use client";

import { useEffect, useCallback } from "react";
import { useSocket } from "@/hooks/useSocket";
import { useAppStore, type AppStoreEntry } from "@/stores/app-store";
import { AppStoreHeader } from "./AppStoreHeader";
import { AppStoreFeatured } from "./AppStoreFeatured";
import { AppStoreSection } from "./AppStoreSection";
import { AppStoreCategory } from "./AppStoreCategory";
import { AppDetail } from "./AppDetail";
import { FALLBACK_CATALOG } from "./catalog";

const GATEWAY_URL =
  process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:4000";

interface AppStoreProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AppStore({ open, onOpenChange }: AppStoreProps) {
  const { send } = useSocket();
  const {
    entries,
    search,
    selectedCategory,
    selectedApp,
    installedIds,
    setEntries,
    setSearch,
    setCategory,
    selectApp,
    markInstalled,
    featured,
    bundled,
    promptLibrary,
    searchResults,
    newApps,
    topRated,
  } = useAppStore();

  useEffect(() => {
    if (!open) return;
    fetch(`${GATEWAY_URL}/files/system/app-store.json`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: AppStoreEntry[] | null) => {
        if (!data || data.length === 0) return;
        // Merge: runtime data enriched with fallback metadata
        const byId = new Map(data.map((e) => [e.id, e]));
        for (const fallback of FALLBACK_CATALOG) {
          if (!byId.has(fallback.id)) {
            byId.set(fallback.id, fallback);
          } else {
            const existing = byId.get(fallback.id)!;
            byId.set(fallback.id, {
              ...existing,
              category: fallback.category,
              icon: existing.icon ?? fallback.icon,
              iconColor: existing.iconColor ?? fallback.iconColor,
              rating: existing.rating ?? fallback.rating,
              ratingCount: existing.ratingCount ?? fallback.ratingCount,
              downloads: existing.downloads ?? fallback.downloads,
              tags: existing.tags ?? fallback.tags,
              featured: existing.featured ?? fallback.featured,
              featuredTagline: existing.featuredTagline ?? fallback.featuredTagline,
              new: existing.new ?? fallback.new,
              longDescription: existing.longDescription ?? fallback.longDescription,
            });
          }
        }
        setEntries(Array.from(byId.values()));
      })
      .catch(() => {});
  }, [open, setEntries]);

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (selectedApp) {
          selectApp(null);
        } else {
          onOpenChange(false);
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, selectedApp, selectApp, onOpenChange]);

  useEffect(() => {
    if (!open) {
      setSearch("");
      setCategory("All");
      selectApp(null);
    }
  }, [open, setSearch, setCategory, selectApp]);

  const install = useCallback(
    (entry: (typeof entries)[number]) => {
      if (entry.source === "bundled") {
        onOpenChange(false);
      } else if (entry.source === "prompt" && entry.prompt) {
        send({
          type: "message",
          text: `Build an app called "${entry.name}": ${entry.prompt}`,
        });
        markInstalled(entry.id);
        onOpenChange(false);
      }
    },
    [send, onOpenChange, markInstalled],
  );

  if (!open) return null;

  const isSearching = search.length > 0;
  const isFiltered = selectedCategory !== "All";
  const showBrowse = !isSearching && !isFiltered;

  const featuredEntries = featured();
  const results = searchResults();
  const bundledApps = bundled();
  const promptApps = promptLibrary();
  const newEntries = newApps();

  return (
    <div className="fixed inset-0 z-[45]">
      <div
        className="absolute inset-0 bg-background/80 backdrop-blur-lg"
        onClick={(e) => {
          if (e.target === e.currentTarget) onOpenChange(false);
        }}
      />

      <div className="relative flex flex-col h-full z-10 overflow-hidden md:pl-14">
        <AppStoreHeader
          search={search}
          selectedCategory={selectedCategory}
          onSearchChange={setSearch}
          onCategoryChange={setCategory}
          onClose={() => onOpenChange(false)}
        />

        <div className="flex flex-1 min-h-0">
          <div className="flex-1 overflow-y-auto px-6 py-4">
            {showBrowse ? (
              <>
                {featuredEntries.length > 0 && (
                  <AppStoreFeatured
                    entries={featuredEntries}
                    onSelect={selectApp}
                    onInstall={install}
                  />
                )}

                {newEntries.length > 0 && (
                  <AppStoreSection
                    title="New This Week"
                    entries={newEntries}
                    installedIds={installedIds}
                    onSelect={selectApp}
                    onInstall={install}
                  />
                )}

                {bundledApps.length > 0 && (
                  <section className="mb-8">
                    <h3 className="text-sm font-semibold mb-3 px-1">Ready to Use</h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-1">
                      {bundledApps.map((entry) => (
                        <AppCardInGrid
                          key={entry.id}
                          entry={entry}
                          installedIds={installedIds}
                          onSelect={selectApp}
                          onInstall={install}
                        />
                      ))}
                    </div>
                  </section>
                )}

                {promptApps.length > 0 && (
                  <section className="mb-8">
                    <div className="flex items-center gap-2 mb-3 px-1">
                      <h3 className="text-sm font-semibold">Build with AI</h3>
                      <span className="text-[10px] text-muted-foreground bg-muted rounded-full px-2 py-0.5">
                        {promptApps.length} prompts
                      </span>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-1">
                      {promptApps.map((entry) => (
                        <AppCardInGrid
                          key={entry.id}
                          entry={entry}
                          installedIds={installedIds}
                          onSelect={selectApp}
                          onInstall={install}
                        />
                      ))}
                    </div>
                  </section>
                )}
              </>
            ) : (
              <AppStoreCategory
                entries={results}
                installedIds={installedIds}
                onSelect={selectApp}
                onInstall={install}
              />
            )}
          </div>

          {selectedApp && (
            <AppDetail
              entry={selectedApp}
              installed={installedIds.has(selectedApp.id)}
              onClose={() => selectApp(null)}
              onInstall={() => install(selectedApp)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

import { AppCard } from "./AppCard";

function AppCardInGrid({
  entry,
  installedIds,
  onSelect,
  onInstall,
}: {
  entry: AppStoreEntry;
  installedIds: Set<string>;
  onSelect: (entry: AppStoreEntry) => void;
  onInstall: (entry: AppStoreEntry) => void;
}) {
  return (
    <AppCard
      entry={entry}
      installed={installedIds.has(entry.id)}
      onSelect={() => onSelect(entry)}
      onInstall={() => onInstall(entry)}
    />
  );
}
