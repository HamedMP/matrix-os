"use client";

import { useState } from "react";
import { useFileBrowser } from "@/hooks/useFileBrowser";
import { XpToolMenu, type XpMenuItem } from "./XpToolMenu";
import {
  XpChevronGlyph,
  XpFolderGlyph,
  XpRoundArrowGlyph,
  XpSearchGlyph,
  XpUpGlyph,
  XpViewsGlyph,
} from "./xp-icons";

interface XpToolbarProps {
  taskPaneOpen: boolean;
  onToggleTaskPane: () => void;
}

function pathLabel(path: string): string {
  return path === "" ? "Home" : path;
}

export function XpToolbar({ taskPaneOpen, onToggleTaskPane }: XpToolbarProps) {
  const currentPath = useFileBrowser((s) => s.currentPath);
  const history = useFileBrowser((s) => s.history);
  const historyIndex = useFileBrowser((s) => s.historyIndex);
  const viewMode = useFileBrowser((s) => s.viewMode);
  const goBack = useFileBrowser((s) => s.goBack);
  const goForward = useFileBrowser((s) => s.goForward);
  const navigate = useFileBrowser((s) => s.navigate);
  const setViewMode = useFileBrowser((s) => s.setViewMode);
  const search = useFileBrowser((s) => s.search);
  const clearSearch = useFileBrowser((s) => s.clearSearch);

  const [openMenu, setOpenMenu] = useState<"back" | "forward" | "views" | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");

  const canGoBack = historyIndex > 0;
  const canGoForward = historyIndex < history.length - 1;

  const goUp = () => {
    if (!currentPath) return;
    const parent = currentPath.includes("/")
      ? currentPath.slice(0, currentPath.lastIndexOf("/"))
      : "";
    navigate(parent);
  };

  const backItems: XpMenuItem[] = history
    .slice(0, historyIndex)
    .map((path, idx) => ({
      label: pathLabel(path),
      action: () => {
        for (let i = 0; i < historyIndex - idx; i++) goBack();
      },
    }))
    .reverse();

  const forwardItems: XpMenuItem[] = history
    .slice(historyIndex + 1)
    .map((path, idx) => ({
      label: pathLabel(path),
      action: () => {
        for (let i = 0; i < idx + 1; i++) goForward();
      },
    }));

  const viewItems: XpMenuItem[] = [
    { label: "Tiles", checked: viewMode === "icon", action: () => setViewMode("icon") },
    { label: "List", checked: viewMode === "list", action: () => setViewMode("list") },
    { label: "Columns", checked: viewMode === "column", action: () => setViewMode("column") },
  ];

  const toggleSearch = () => {
    if (searchOpen) {
      setQuery("");
      clearSearch();
      setSearchOpen(false);
    } else {
      setSearchOpen(true);
    }
  };

  const submitSearch = () => {
    if (query.trim()) {
      search(query);
    } else {
      clearSearch();
    }
  };

  return (
    <div className="xp-toolbar">
      <div className="xp-tool-group">
        <XpToolMenu
          open={openMenu === "back"}
          onClose={() => setOpenMenu(null)}
          items={backItems}
          trigger={
            <span className="xp-tool-split">
              <button
                type="button"
                className="xp-tool-btn"
                aria-label="Back"
                disabled={!canGoBack}
                onClick={goBack}
              >
                <XpRoundArrowGlyph direction="left" />
                Back
              </button>
              <button
                type="button"
                className="xp-tool-btn xp-tool-chevron-btn"
                aria-label="Back history"
                aria-expanded={openMenu === "back"}
                disabled={!canGoBack}
                onClick={() => setOpenMenu(openMenu === "back" ? null : "back")}
              >
                <XpChevronGlyph className="xp-chevron" />
              </button>
            </span>
          }
        />
        <XpToolMenu
          open={openMenu === "forward"}
          onClose={() => setOpenMenu(null)}
          items={forwardItems}
          trigger={
            <span className="xp-tool-split">
              <button
                type="button"
                className="xp-tool-btn"
                aria-label="Forward"
                disabled={!canGoForward}
                onClick={goForward}
              >
                <XpRoundArrowGlyph direction="right" />
                Forward
              </button>
              <button
                type="button"
                className="xp-tool-btn xp-tool-chevron-btn"
                aria-label="Forward history"
                aria-expanded={openMenu === "forward"}
                disabled={!canGoForward}
                onClick={() => setOpenMenu(openMenu === "forward" ? null : "forward")}
              >
                <XpChevronGlyph className="xp-chevron" />
              </button>
            </span>
          }
        />
        <button
          type="button"
          className="xp-tool-btn"
          aria-label="Up"
          disabled={!currentPath}
          onClick={goUp}
        >
          <XpUpGlyph />
          Up
        </button>
      </div>

      <span className="xp-tool-separator" />

      <div className="xp-tool-group">
        <button
          type="button"
          className="xp-tool-btn"
          aria-label="Search"
          aria-pressed={searchOpen}
          onClick={toggleSearch}
        >
          <XpSearchGlyph />
          Search
        </button>
        <button
          type="button"
          className="xp-tool-btn"
          aria-label="Folders"
          aria-pressed={taskPaneOpen}
          onClick={onToggleTaskPane}
        >
          <XpFolderGlyph size={22} />
          Folders
        </button>
        <XpToolMenu
          open={openMenu === "views"}
          onClose={() => setOpenMenu(null)}
          items={viewItems}
          trigger={
            <button
              type="button"
              className="xp-tool-btn"
              aria-label="Views"
              aria-expanded={openMenu === "views"}
              onClick={() => setOpenMenu(openMenu === "views" ? null : "views")}
            >
              <XpViewsGlyph />
              Views
              <XpChevronGlyph className="xp-chevron" />
            </button>
          }
        />
      </div>

      {searchOpen && (
        <span className="xp-tool-search">
          <input
            aria-label="Search files"
            placeholder="Search for files or folders"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitSearch();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setQuery("");
                clearSearch();
                setSearchOpen(false);
              }
            }}
          />
        </span>
      )}
    </div>
  );
}
