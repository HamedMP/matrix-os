"use client";

import { useState, useEffect } from "react";
import { useFileBrowser, type FileEntry } from "@/hooks/useFileBrowser";
import { usePreviewWindow } from "@/hooks/usePreviewWindow";
import { getGatewayUrl } from "@/lib/gateway";
import { cn } from "@/lib/utils";
import { FolderIcon, FileTextIcon, ChevronRightIcon } from "lucide-react";

const GATEWAY_URL = getGatewayUrl();
const MAX_VISIBLE_COLUMNS = 5;
const MIN_COLUMN_WIDTH = 180;

interface Column {
  path: string;
  entries: FileEntry[];
  selected: string | null;
}

export function ColumnView() {
  const currentPath = useFileBrowser((s) => s.currentPath);
  const navigate = useFileBrowser((s) => s.navigate);
  const openFile = usePreviewWindow((s) => s.openFile);
  const [columns, setColumns] = useState<Column[]>([]);

  useEffect(() => {
    async function load() {
      const segments = currentPath ? currentPath.split("/") : [];
      const cols: Column[] = [];

      const paths = ["", ...segments.map((_, i) => segments.slice(0, i + 1).join("/"))];

      for (const p of paths) {
        try {
          const res = await fetch(`${GATEWAY_URL}/api/files/list?path=${encodeURIComponent(p)}`);
          if (res.ok) {
            const data = await res.json();
            const entries: FileEntry[] = data.entries ?? data;
            const nextSeg = segments[cols.length] ?? null;
            cols.push({ path: p, entries, selected: nextSeg });
          }
        } catch {
          break;
        }
      }

      setColumns(cols);
    }
    load();
  }, [currentPath]);

  function handleSelect(colIndex: number, entry: FileEntry) {
    if (entry.type === "directory") {
      const col = columns[colIndex];
      const newPath = col.path ? `${col.path}/${entry.name}` : entry.name;
      navigate(newPath);
    } else {
      const col = columns[colIndex];
      const filePath = col.path ? `${col.path}/${entry.name}` : entry.name;
      openFile(filePath);
    }
  }

  return (
    <div
      className="flex h-full overflow-x-auto"
      role="tree"
      aria-label="Column browser"
    >
      {columns.slice(-MAX_VISIBLE_COLUMNS).map((col, i) => (
        <div
          key={col.path || "__root__"}
          className="flex-shrink-0 border-r border-border overflow-y-auto"
          style={{ minWidth: MIN_COLUMN_WIDTH, width: 220 }}
        >
          {col.entries.map((entry) => {
            const isSelected = col.selected === entry.name;
            return (
              <div
                key={entry.name}
                role="treeitem"
                aria-selected={isSelected}
                className={cn(
                  "flex items-center gap-2 px-3 py-1 text-sm cursor-default select-none",
                  "hover:bg-accent/50 transition-colors",
                  isSelected && "bg-accent",
                )}
                onClick={() => handleSelect(i + Math.max(0, columns.length - MAX_VISIBLE_COLUMNS), entry)}
              >
                {entry.type === "directory" ? (
                  <FolderIcon className="size-4 text-blue-400 shrink-0" />
                ) : (
                  <FileTextIcon className="size-4 text-muted-foreground shrink-0" />
                )}
                <span className="truncate flex-1">{entry.name}</span>
                {entry.type === "directory" && (
                  <ChevronRightIcon className="size-3 text-muted-foreground shrink-0" />
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
