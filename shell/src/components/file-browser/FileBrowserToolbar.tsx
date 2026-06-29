"use client";

import { useState, useRef, useEffect } from "react";
import { useFileBrowser } from "@/hooks/useFileBrowser";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  LayoutGridIcon,
  ListIcon,
  ColumnsIcon,
  SearchIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

export function FileBrowserToolbar({ mobile = false }: { mobile?: boolean }) {
  const currentPath = useFileBrowser((s) => s.currentPath);
  const historyIndex = useFileBrowser((s) => s.historyIndex);
  const history = useFileBrowser((s) => s.history);
  const viewMode = useFileBrowser((s) => s.viewMode);
  const searchQuery = useFileBrowser((s) => s.searchQuery);
  const navigate = useFileBrowser((s) => s.navigate);
  const goBack = useFileBrowser((s) => s.goBack);
  const goForward = useFileBrowser((s) => s.goForward);
  const setViewMode = useFileBrowser((s) => s.setViewMode);
  const search = useFileBrowser((s) => s.search);
  const clearSearch = useFileBrowser((s) => s.clearSearch);

  const [localQuery, setLocalQuery] = useState(searchQuery);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // react-doctor-disable-next-line react-doctor/no-derived-state-effect -- `localQuery` is a debounced input buffer that intentionally diverges from the store's `searchQuery` between keystrokes; it cannot be computed in render. This effect resyncs it only when `searchQuery` changes from outside (e.g. clearSearch elsewhere), an external-system sync, not a render-time derivation.
  useEffect(() => {
    // react-doctor-disable-next-line react-hooks-js/set-state-in-effect -- adopts the externally-changed store value into the local input buffer; the buffer is not derivable in render because it holds in-flight user typing between debounce ticks.
    setLocalQuery(searchQuery);
  }, [searchQuery]);

  const handleSearchChange = (value: string) => {
    setLocalQuery(value);
    clearTimeout(debounceRef.current);
    if (!value.trim()) {
      clearSearch();
      return;
    }
    debounceRef.current = setTimeout(() => search(value), 300);
  };

  const pathSegments = currentPath ? currentPath.split("/") : [];
  // Comfortable ≥44px touch targets on mobile; unchanged on desktop.
  const navBtn = mobile ? "size-9" : "size-7";

  return (
    <div
      className={cn(
        "flex items-center gap-2 border-b overflow-x-auto",
        mobile ? "surface-glass px-3 py-2" : "px-3 py-1.5 border-border bg-background/80",
      )}
    >
      <div className="flex items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon"
          className={navBtn}
          disabled={historyIndex <= 0}
          onClick={goBack}
          aria-label="Go back"
        >
          <ChevronLeftIcon className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={navBtn}
          disabled={historyIndex >= history.length - 1}
          onClick={goForward}
          aria-label="Go forward"
        >
          <ChevronRightIcon className="size-4" />
        </Button>
      </div>

      <div className="flex items-center gap-1 text-sm flex-1 min-w-0">
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground px-1 shrink-0"
          onClick={() => navigate("")}
        >
          ~
        </button>
        {pathSegments.map((seg, i) => (
          <span key={pathSegments.slice(0, i + 1).join("/")} className="flex items-center gap-1 min-w-0">
            <span className="text-muted-foreground">/</span>
            <button
              type="button"
              className="hover:text-foreground truncate"
              onClick={() => navigate(pathSegments.slice(0, i + 1).join("/"))}
            >
              {seg}
            </button>
          </span>
        ))}
      </div>

      <div className="flex items-center border rounded-md shrink-0">
        {(
          [
            ["icon", LayoutGridIcon],
            ["list", ListIcon],
            ["column", ColumnsIcon],
          ] as const
        ).map(([mode, Icon]) => (
          <Button
            key={mode}
            variant="ghost"
            size="icon"
            className={cn(
              navBtn,
              "rounded-none first:rounded-l-md last:rounded-r-md",
              viewMode === mode && "bg-accent",
            )}
            onClick={() => setViewMode(mode)}
            aria-label={`${mode} view`}
          >
            <Icon className="size-3.5" />
          </Button>
        ))}
      </div>

      <div className={mobile ? "hidden" : "relative w-40"}>
        <SearchIcon className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
        <Input
          className="h-7 pl-7 text-xs"
          placeholder="Search..."
          value={localQuery}
          onChange={(e) => handleSearchChange(e.target.value)}
          aria-label="Search files"
        />
      </div>
    </div>
  );
}
