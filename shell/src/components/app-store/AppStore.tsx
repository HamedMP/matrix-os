"use client";

import { useEffect, useCallback, useMemo, useState } from "react";
import { useSocket } from "@/hooks/useSocket";
import { useAppStore, type AppStoreEntry } from "@/stores/app-store";
import { AppStoreHeader } from "./AppStoreHeader";
import { AppDetail } from "./AppDetail";
import { InstallDialog } from "./InstallDialog";
import { PublishDialog } from "./PublishDialog";
import { getGatewayUrl } from "@/lib/gateway";
import { StoreIcon, UploadIcon, PackageIcon } from "lucide-react";

const GATEWAY_URL = getGatewayUrl();

interface AppStoreProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface LocalApp {
  name: string;
  description?: string;
  icon?: string;
  category?: string;
  version?: string;
  file: string;
  path: string;
}

export function AppStore({ open, onOpenChange }: AppStoreProps) {
  const { send } = useSocket();
  const entries = useAppStore((s) => s.entries);
  const search = useAppStore((s) => s.search);
  const selectedCategory = useAppStore((s) => s.selectedCategory);
  const selectedApp = useAppStore((s) => s.selectedApp);
  const installedIds = useAppStore((s) => s.installedIds);
  const loading = useAppStore((s) => s.loading);
  const setSearch = useAppStore((s) => s.setSearch);
  const setCategory = useAppStore((s) => s.setCategory);
  const selectApp = useAppStore((s) => s.selectApp);
  const markInstalled = useAppStore((s) => s.markInstalled);
  const fetchGalleryApps = useAppStore((s) => s.fetchGalleryApps);
  const fetchInstallations = useAppStore((s) => s.fetchInstallations);

  const [installTarget, setInstallTarget] = useState<AppStoreEntry | null>(null);
  const [publishTarget, setPublishTarget] = useState<{ slug: string; name: string } | null>(null);
  const [showPublishPicker, setShowPublishPicker] = useState(false);
  const [localApps, setLocalApps] = useState<LocalApp[]>([]);
  const [loadingApps, setLoadingApps] = useState(false);

  useEffect(() => {
    if (!open) return;
    fetchGalleryApps();
    fetchInstallations();
  }, [open, fetchGalleryApps, fetchInstallations]);

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (installTarget) {
          setInstallTarget(null);
        } else if (publishTarget) {
          setPublishTarget(null);
        } else if (showPublishPicker) {
          setShowPublishPicker(false);
        } else if (selectedApp) {
          selectApp(null);
        } else {
          onOpenChange(false);
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, selectedApp, selectApp, onOpenChange, installTarget, publishTarget, showPublishPicker]);

  useEffect(() => {
    if (!open) {
      setSearch("");
      setCategory("All");
      selectApp(null);
      setInstallTarget(null);
      setPublishTarget(null);
      setShowPublishPicker(false);
    }
  }, [open, setSearch, setCategory, selectApp]);

  const openPublishPicker = useCallback(async () => {
    setShowPublishPicker(true);
    setLoadingApps(true);
    try {
      const res = await fetch(`${GATEWAY_URL}/api/apps`, {
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        const apps = await res.json();
        setLocalApps(Array.isArray(apps) ? apps : []);
      }
    } catch {
      // ignore
    } finally {
      setLoadingApps(false);
    }
  }, []);

  const install = useCallback(
    (entry: AppStoreEntry) => {
      if (entry.source === "gallery" && entry.listingId) {
        setInstallTarget(entry);
      }
    },
    [],
  );

  const isSearching = search.length > 0;
  const isFiltered = selectedCategory !== "All";

  const results = useMemo(() => {
    let filtered = selectedCategory === "All"
      ? entries
      : entries.filter(
          (e) => e.category.toLowerCase() === selectedCategory.toLowerCase(),
        );
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

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[45] bg-background">
      <div className="flex flex-col h-full overflow-hidden md:pl-14">
        <AppStoreHeader
          search={search}
          selectedCategory={selectedCategory}
          onSearchChange={setSearch}
          onCategoryChange={setCategory}
          onClose={() => onOpenChange(false)}
        />

        <div className="flex flex-1 min-h-0">
          <div className="flex-1 overflow-y-auto px-6 py-4">
            {/* Publish button */}
            <div className="flex items-center gap-3 mb-6">
              <button
                onClick={openPublishPicker}
                className="flex items-center gap-2 rounded-xl border border-dashed border-primary/40 bg-primary/5 px-4 py-2.5 text-sm font-medium text-primary hover:bg-primary/10 transition-colors"
              >
                <UploadIcon className="size-4" />
                Publish an App
              </button>
              {entries.length > 0 && (
                <span className="text-xs text-muted-foreground">
                  {entries.length} app{entries.length !== 1 ? "s" : ""} in gallery
                </span>
              )}
            </div>

            {/* Gallery content */}
            {entries.length === 0 && !loading ? (
              <div className="flex flex-col items-center justify-center py-20 text-center">
                <div className="size-16 rounded-2xl bg-muted/60 flex items-center justify-center mb-4">
                  <StoreIcon className="size-7 text-muted-foreground" />
                </div>
                <h2 className="text-lg font-semibold mb-1">No apps published yet</h2>
                <p className="text-sm text-muted-foreground max-w-sm mb-4">
                  Build an app with your AI agent, then publish it to the gallery for everyone to discover and install.
                </p>
                <button
                  onClick={openPublishPicker}
                  className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
                >
                  <UploadIcon className="size-4" />
                  Publish Your First App
                </button>
              </div>
            ) : loading ? (
              <div className="flex items-center justify-center py-20">
                <div className="size-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              </div>
            ) : results.length > 0 ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-1">
                {results.map((entry) => (
                  <AppCardInGrid
                    key={entry.id}
                    entry={entry}
                    installedIds={installedIds}
                    onSelect={selectApp}
                    onInstall={install}
                  />
                ))}
              </div>
            ) : (isSearching || isFiltered) ? (
              <div className="flex flex-col items-center justify-center py-20 text-center">
                <p className="text-sm text-muted-foreground">No apps match your search.</p>
              </div>
            ) : null}
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

      {/* Publish picker overlay */}
      {showPublishPicker && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={() => setShowPublishPicker(false)} />
          <div className="relative bg-card rounded-2xl border border-border shadow-xl w-full max-w-md max-h-[80vh] overflow-hidden z-10">
            <div className="flex items-center justify-between p-4 border-b border-border">
              <h2 className="text-base font-semibold">Choose an app to publish</h2>
              <button
                onClick={() => setShowPublishPicker(false)}
                className="size-7 flex items-center justify-center rounded-md hover:bg-muted text-muted-foreground"
              >
                &times;
              </button>
            </div>
            <div className="overflow-y-auto max-h-[60vh] p-2">
              {loadingApps ? (
                <div className="flex items-center justify-center py-12">
                  <div className="size-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                </div>
              ) : localApps.length === 0 ? (
                <div className="text-center py-12 text-sm text-muted-foreground">
                  <PackageIcon className="size-8 mx-auto mb-2 text-muted-foreground/50" />
                  <p>No apps found in your workspace.</p>
                  <p className="mt-1">Ask your AI agent to build one first.</p>
                </div>
              ) : (
                localApps.map((app) => {
                  const slug = app.file.replace(/^apps\//, "").replace(/\/$/, "").split("/")[0];
                  return (
                    <button
                      key={app.path}
                      onClick={() => {
                        setShowPublishPicker(false);
                        setPublishTarget({ slug, name: app.name });
                      }}
                      className="w-full flex items-center gap-3 rounded-lg p-3 text-left hover:bg-muted/80 transition-colors"
                    >
                      <div
                        className="size-10 rounded-xl flex items-center justify-center text-sm font-bold text-white shrink-0"
                        style={{ backgroundColor: "#6366f1" }}
                      >
                        {app.icon || app.name.charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-sm truncate">{app.name}</div>
                        {app.description && (
                          <div className="text-xs text-muted-foreground truncate">{app.description}</div>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground shrink-0">
                        {app.version ?? "1.0.0"}
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

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
          onClose={() => {
            setPublishTarget(null);
            fetchGalleryApps();
          }}
        />
      )}
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
