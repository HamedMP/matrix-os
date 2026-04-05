"use client";

import { useEffect, useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useSocket } from "@/hooks/useSocket";
import { useAppStore, type AppStoreEntry } from "@/stores/app-store";
import { AppStoreHeader } from "@/components/app-store/AppStoreHeader";
import { AppStoreFeatured } from "@/components/app-store/AppStoreFeatured";
import { AppStoreSection } from "@/components/app-store/AppStoreSection";
import { AppStoreCategory } from "@/components/app-store/AppStoreCategory";
import { AppDetail } from "@/components/app-store/AppDetail";
import { AppCard } from "@/components/app-store/AppCard";
import { InstallDialog } from "@/components/app-store/InstallDialog";
import { PublishDialog } from "@/components/app-store/PublishDialog";
import { FALLBACK_CATALOG } from "@/components/app-store/catalog";
import { getGatewayUrl } from "@/lib/gateway";

const GATEWAY_URL = getGatewayUrl();

export default function StorePage() {
  const router = useRouter();
  const { send } = useSocket();
  const entries = useAppStore((s) => s.entries);
  const search = useAppStore((s) => s.search);
  const selectedCategory = useAppStore((s) => s.selectedCategory);
  const selectedApp = useAppStore((s) => s.selectedApp);
  const installedIds = useAppStore((s) => s.installedIds);
  const setEntries = useAppStore((s) => s.setEntries);
  const setSearch = useAppStore((s) => s.setSearch);
  const setCategory = useAppStore((s) => s.setCategory);
  const selectApp = useAppStore((s) => s.selectApp);
  const markInstalled = useAppStore((s) => s.markInstalled);
  const fetchGalleryApps = useAppStore((s) => s.fetchGalleryApps);
  const fetchInstallations = useAppStore((s) => s.fetchInstallations);

  const [installTarget, setInstallTarget] = useState<AppStoreEntry | null>(null);
  const [publishTarget, setPublishTarget] = useState<{ slug: string; name: string } | null>(null);

  useEffect(() => {
    fetchGalleryApps();
    fetchInstallations();

    fetch(`${GATEWAY_URL}/files/system/app-store.json`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: AppStoreEntry[] | null) => {
        if (!data || data.length === 0) return;
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
  }, [setEntries, fetchGalleryApps, fetchInstallations]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (installTarget) {
          setInstallTarget(null);
        } else if (publishTarget) {
          setPublishTarget(null);
        } else if (selectedApp) {
          selectApp(null);
        } else {
          router.push("/");
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedApp, selectApp, router, installTarget, publishTarget]);

  const install = useCallback(
    (entry: AppStoreEntry) => {
      if (entry.source === "bundled") {
        router.push("/");
      } else if (entry.source === "prompt" && entry.prompt) {
        send({
          type: "message",
          text: `Build an app called "${entry.name}": ${entry.prompt}`,
        });
        markInstalled(entry.id);
        router.push("/");
      } else if (entry.source === "gallery" && entry.listingId) {
        setInstallTarget(entry);
      }
    },
    [send, router, markInstalled],
  );

  const isSearching = search.length > 0;
  const isFiltered = selectedCategory !== "All";
  const showBrowse = !isSearching && !isFiltered;

  const featuredEntries = useMemo(() => entries.filter((e) => e.featured), [entries]);
  const bundledApps = useMemo(() => entries.filter((e) => e.source === "bundled"), [entries]);
  const promptApps = useMemo(() => entries.filter((e) => e.source === "prompt"), [entries]);
  const galleryApps = useMemo(() => entries.filter((e) => e.source === "gallery"), [entries]);
  const newEntries = useMemo(() => entries.filter((e) => e.new), [entries]);

  const results = useMemo(() => {
    let filtered = selectedCategory === "All"
      ? entries
      : entries.filter((e) => e.category.toLowerCase() === selectedCategory.toLowerCase());
    if (search) {
      const q = search.toLowerCase();
      filtered = filtered.filter(
        (e) =>
          e.name.toLowerCase().includes(q) ||
          e.description.toLowerCase().includes(q) ||
          (e.tags ?? []).some((t) => t.toLowerCase().includes(q)),
      );
    }
    return filtered;
  }, [entries, selectedCategory, search]);

  return (
    <div className="flex flex-col h-screen bg-background">
      <AppStoreHeader
        search={search}
        selectedCategory={selectedCategory}
        onSearchChange={setSearch}
        onCategoryChange={setCategory}
        onClose={() => router.push("/")}
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

              {galleryApps.length > 0 && (
                <section className="mb-8">
                  <div className="flex items-center gap-2 mb-3 px-1">
                    <h3 className="text-sm font-semibold">Community Apps</h3>
                    <span className="text-[10px] text-muted-foreground bg-muted rounded-full px-2 py-0.5">
                      {galleryApps.length} apps
                    </span>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-1">
                    {galleryApps.map((entry) => (
                      <AppCard
                        key={entry.id}
                        entry={entry}
                        installed={installedIds.has(entry.id)}
                        onSelect={() => selectApp(entry)}
                        onInstall={() => install(entry)}
                      />
                    ))}
                  </div>
                </section>
              )}

              {bundledApps.length > 0 && (
                <section className="mb-8">
                  <h3 className="text-sm font-semibold mb-3 px-1">Ready to Use</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-1">
                    {bundledApps.map((entry) => (
                      <AppCard
                        key={entry.id}
                        entry={entry}
                        installed={installedIds.has(entry.id)}
                        onSelect={() => selectApp(entry)}
                        onInstall={() => install(entry)}
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
                      <AppCard
                        key={entry.id}
                        entry={entry}
                        installed={installedIds.has(entry.id)}
                        onSelect={() => selectApp(entry)}
                        onInstall={() => install(entry)}
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

      {installTarget && installTarget.listingId && (
        <InstallDialog
          listingId={installTarget.listingId}
          name={installTarget.name}
          permissions={installTarget.permissions ?? []}
          integrations={installTarget.integrations}
          onClose={() => setInstallTarget(null)}
          onInstalled={() => {
            markInstalled(installTarget.id);
            setInstallTarget(null);
            selectApp(null);
          }}
        />
      )}

      {publishTarget && (
        <PublishDialog
          appSlug={publishTarget.slug}
          appName={publishTarget.name}
          onClose={() => setPublishTarget(null)}
        />
      )}
    </div>
  );
}
