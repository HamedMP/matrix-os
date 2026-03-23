"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useFileBrowser } from "@/hooks/useFileBrowser";
import { usePreviewWindow } from "@/hooks/usePreviewWindow";
import { useFileWatcher } from "@/hooks/useFileWatcher";
import { FileBrowserToolbar } from "./FileBrowserToolbar";
import { FileBrowserSidebar } from "./FileBrowserSidebar";
import { FileBrowserContent } from "./FileBrowserContent";
import { PreviewPanel } from "./PreviewPanel";
import { SearchResults } from "./SearchResults";
import { TrashView } from "./TrashView";
import { StatusBar } from "./StatusBar";
import { FileContextMenu } from "./FileContextMenu";
import { QuickLook } from "./QuickLook";

interface FileBrowserProps {
  windowId: string;
}

export function FileBrowser({ windowId }: FileBrowserProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [showingTrash, setShowingTrash] = useState(false);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);

  const currentPath = useFileBrowser((s) => s.currentPath);
  const navigate = useFileBrowser((s) => s.navigate);
  const goBack = useFileBrowser((s) => s.goBack);
  const goForward = useFileBrowser((s) => s.goForward);
  const refresh = useFileBrowser((s) => s.refresh);
  const selectedPaths = useFileBrowser((s) => s.selectedPaths);
  const entries = useFileBrowser((s) => s.entries);
  const select = useFileBrowser((s) => s.select);
  const selectAll = useFileBrowser((s) => s.selectAll);
  const copy = useFileBrowser((s) => s.copy);
  const cut = useFileBrowser((s) => s.cut);
  const paste = useFileBrowser((s) => s.paste);
  const deleteFiles = useFileBrowser((s) => s.deleteFiles);
  const duplicate = useFileBrowser((s) => s.duplicate);
  const createFolder = useFileBrowser((s) => s.createFolder);
  const quickLookPath = useFileBrowser((s) => s.quickLookPath);
  const setQuickLookPath = useFileBrowser((s) => s.setQuickLookPath);
  const togglePreviewPanel = useFileBrowser((s) => s.togglePreviewPanel);
  const searchResults = useFileBrowser((s) => s.searchResults);
  const openFile = usePreviewWindow((s) => s.openFile);

  // Load initial directory
  useEffect(() => {
    navigate(currentPath || "");
  }, []);

  // File watcher integration
  const onFileChange = useCallback(
    (path: string, _event: "add" | "change" | "unlink") => {
      const parentDir = path.includes("/")
        ? path.slice(0, path.lastIndexOf("/"))
        : "";
      if (parentDir === currentPath || path.startsWith(currentPath + "/")) {
        refresh();
      }
    },
    [currentPath, refresh],
  );

  useFileWatcher(onFileChange);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      const shift = e.shiftKey;

      // Quick Look shortcuts
      if (quickLookPath) {
        if (e.key === " " || e.key === "Escape") {
          e.preventDefault();
          setQuickLookPath(null);
          return;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          const fullPath = currentPath
            ? `${currentPath}/${quickLookPath}`
            : quickLookPath;
          openFile(fullPath);
          setQuickLookPath(null);
          return;
        }
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const idx = entries.findIndex((en) => en.name === quickLookPath);
          const next =
            e.key === "ArrowDown"
              ? entries[idx + 1]
              : entries[idx - 1];
          if (next) {
            setQuickLookPath(next.name);
            select(next.name);
          }
          return;
        }
      }

      // Space for Quick Look
      if (e.key === " " && selectedPaths.size === 1 && !renamingPath) {
        e.preventDefault();
        setQuickLookPath(Array.from(selectedPaths)[0]);
        return;
      }

      // Navigation
      if (meta && e.key === "[") {
        e.preventDefault();
        goBack();
        return;
      }
      if (meta && e.key === "]") {
        e.preventDefault();
        goForward();
        return;
      }
      if (meta && e.key === "ArrowUp") {
        e.preventDefault();
        const parentPath = currentPath.includes("/")
          ? currentPath.slice(0, currentPath.lastIndexOf("/"))
          : "";
        if (currentPath) navigate(parentPath);
        return;
      }
      if (meta && e.key === "ArrowDown") {
        e.preventDefault();
        if (selectedPaths.size === 1) {
          const name = Array.from(selectedPaths)[0];
          const entry = entries.find((en) => en.name === name);
          if (entry?.type === "directory") {
            navigate(currentPath ? `${currentPath}/${name}` : name);
          } else if (entry) {
            openFile(currentPath ? `${currentPath}/${name}` : name);
          }
        }
        return;
      }

      // Arrow keys for selection
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !meta && !renamingPath) {
        e.preventDefault();
        const lastSelected = selectedPaths.size > 0
          ? Array.from(selectedPaths).pop()!
          : null;
        const idx = lastSelected
          ? entries.findIndex((en) => en.name === lastSelected)
          : -1;
        const next = e.key === "ArrowDown"
          ? entries[idx + 1]
          : entries[Math.max(0, idx - 1)];
        if (next) select(next.name);
        return;
      }

      // Clipboard
      if (meta && e.key === "c") {
        e.preventDefault();
        const paths = Array.from(selectedPaths).map((n) =>
          currentPath ? `${currentPath}/${n}` : n,
        );
        copy(paths);
        return;
      }
      if (meta && e.key === "x") {
        e.preventDefault();
        const paths = Array.from(selectedPaths).map((n) =>
          currentPath ? `${currentPath}/${n}` : n,
        );
        cut(paths);
        return;
      }
      if (meta && e.key === "v") {
        e.preventDefault();
        paste();
        return;
      }

      // Select all
      if (meta && e.key === "a") {
        e.preventDefault();
        selectAll();
        return;
      }

      // Delete
      if (meta && e.key === "Backspace") {
        e.preventDefault();
        const paths = Array.from(selectedPaths).map((n) =>
          currentPath ? `${currentPath}/${n}` : n,
        );
        deleteFiles(paths);
        return;
      }

      // Duplicate
      if (meta && shift && e.key === "D") {
        e.preventDefault();
        const paths = Array.from(selectedPaths).map((n) =>
          currentPath ? `${currentPath}/${n}` : n,
        );
        duplicate(paths);
        return;
      }

      // New folder
      if (meta && shift && e.key === "N") {
        e.preventDefault();
        createFolder("New Folder");
        return;
      }

      // Toggle preview panel
      if (meta && shift && e.key === "I") {
        e.preventDefault();
        togglePreviewPanel();
        return;
      }

      // F2 for rename
      if (e.key === "F2" && selectedPaths.size === 1) {
        e.preventDefault();
        setRenamingPath(Array.from(selectedPaths)[0]);
        return;
      }

      // Enter: open folder or start rename (for files, delayed)
      if (e.key === "Enter" && selectedPaths.size === 1 && !renamingPath) {
        e.preventDefault();
        const name = Array.from(selectedPaths)[0];
        const entry = entries.find((en) => en.name === name);
        if (entry?.type === "directory") {
          navigate(currentPath ? `${currentPath}/${name}` : name);
        } else {
          // Start rename for files
          setRenamingPath(name);
        }
        return;
      }
    },
    [
      currentPath, selectedPaths, entries, quickLookPath, renamingPath,
      navigate, goBack, goForward, select, selectAll, copy, cut, paste,
      deleteFiles, duplicate, createFolder, togglePreviewPanel,
      setQuickLookPath, openFile, refresh,
    ],
  );

  return (
    <div
      ref={containerRef}
      className="flex flex-col h-full outline-none"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <FileBrowserToolbar />
      <div className="flex flex-1 min-h-0">
        <FileBrowserSidebar
          onTrashClick={() => setShowingTrash(!showingTrash)}
          showingTrash={showingTrash}
        />
        <FileContextMenu>
          <div className="flex-1 min-w-0 overflow-auto">
            {showingTrash ? (
              <TrashView />
            ) : searchResults ? (
              <SearchResults />
            ) : (
              <FileBrowserContent
                renamingPath={renamingPath}
                onStartRename={setRenamingPath}
                onCancelRename={() => setRenamingPath(null)}
              />
            )}
          </div>
        </FileContextMenu>
        <PreviewPanel />
      </div>
      <StatusBar />
      <QuickLook />
    </div>
  );
}
