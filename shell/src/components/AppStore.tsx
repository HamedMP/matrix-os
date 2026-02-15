"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { useSocket } from "@/hooks/useSocket";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { DownloadIcon, SearchIcon, SparklesIcon, XIcon } from "lucide-react";

const GATEWAY_URL =
  process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:4000";

interface AppStoreEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  author: string;
  source: "bundled" | "url" | "prompt";
  prompt?: string;
  url?: string;
}

const CATEGORY_LABELS: Record<string, string> = {
  productivity: "Productivity",
  utility: "Utility",
  "dev-tools": "Dev Tools",
  games: "Games",
};

interface AppStoreProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AppStore({ open, onOpenChange }: AppStoreProps) {
  const [entries, setEntries] = useState<AppStoreEntry[]>([]);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const { send } = useSocket();

  useEffect(() => {
    if (!open) return;
    fetch(`${GATEWAY_URL}/files/system/app-store.json`)
      .then((res) => res.ok ? res.json() : [])
      .then(setEntries)
      .catch(() => setEntries([]));
  }, [open]);

  const categories = useMemo(() => {
    const cats = new Set(entries.map((e) => e.category));
    return Array.from(cats).sort();
  }, [entries]);

  const filtered = useMemo(() => {
    let result = entries;
    if (category) result = result.filter((e) => e.category === category);
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (e) =>
          e.name.toLowerCase().includes(q) ||
          e.description.toLowerCase().includes(q),
      );
    }
    return result;
  }, [entries, category, search]);

  const install = useCallback(
    async (entry: AppStoreEntry) => {
      setInstalling(entry.id);
      try {
        if (entry.source === "bundled") {
          // Bundled apps are already in ~/apps/
          onOpenChange(false);
        } else if (entry.source === "prompt" && entry.prompt) {
          send({
            type: "message",
            text: `Build an app called "${entry.name}": ${entry.prompt}`,
          });
          onOpenChange(false);
        }
      } finally {
        setInstalling(null);
      }
    },
    [send, onOpenChange],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>App Store</DialogTitle>
          <DialogDescription>
            Browse and install apps for your Matrix OS
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 mb-3">
          <div className="relative flex-1">
            <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search apps..."
              className="h-8 w-full rounded-md border border-input bg-background pl-8 pr-3 text-sm outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <div className="flex gap-1">
            <Badge
              variant={category === null ? "default" : "outline"}
              className="cursor-pointer text-xs"
              onClick={() => setCategory(null)}
            >
              All
            </Badge>
            {categories.map((cat) => (
              <Badge
                key={cat}
                variant={category === cat ? "default" : "outline"}
                className="cursor-pointer text-xs"
                onClick={() => setCategory(category === cat ? null : cat)}
              >
                {CATEGORY_LABELS[cat] ?? cat}
              </Badge>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 overflow-y-auto flex-1 pr-1">
          {filtered.map((entry) => (
            <div
              key={entry.id}
              className="flex flex-col gap-2 rounded-lg border border-border p-3"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-medium truncate">{entry.name}</span>
                    {entry.source === "prompt" && (
                      <SparklesIcon className="size-3 text-amber-500 shrink-0" />
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                    {entry.description}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant={entry.source === "bundled" ? "outline" : "default"}
                  className="h-7 text-xs shrink-0"
                  onClick={() => install(entry)}
                  disabled={installing === entry.id}
                >
                  {entry.source === "bundled" ? (
                    "Installed"
                  ) : (
                    <>
                      <DownloadIcon className="size-3 mr-1" />
                      {installing === entry.id ? "Installing..." : "Install"}
                    </>
                  )}
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="secondary" className="text-[10px]">
                  {CATEGORY_LABELS[entry.category] ?? entry.category}
                </Badge>
                <span className="text-[10px] text-muted-foreground">
                  by {entry.author}
                </span>
              </div>
            </div>
          ))}

          {filtered.length === 0 && (
            <div className="col-span-2 flex items-center justify-center py-12 text-sm text-muted-foreground">
              No apps found
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
