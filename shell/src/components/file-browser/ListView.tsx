"use client";

import { useFileBrowser, type FileEntry } from "@/hooks/useFileBrowser";
import { InlineRename } from "./InlineRename";
import { cn } from "@/lib/utils";
import {
  FolderIcon,
  FileTextIcon,
  FileCodeIcon,
  ImageIcon,
  ChevronDownIcon,
  ChevronUpIcon,
} from "lucide-react";

function formatSize(bytes?: number): string {
  if (bytes === undefined) return "--";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso?: string): string {
  if (!iso) return "--";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getTypeLabel(entry: FileEntry): string {
  if (entry.type === "directory") return "Folder";
  const ext = entry.name.includes(".")
    ? entry.name.split(".").pop()!.toUpperCase()
    : "";
  return ext ? `${ext} File` : "File";
}

function getSmallIcon(entry: FileEntry) {
  if (entry.type === "directory") return FolderIcon;
  const ext = entry.name.includes(".")
    ? `.${entry.name.split(".").pop()!.toLowerCase()}`
    : "";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(ext))
    return ImageIcon;
  if ([".js", ".ts", ".jsx", ".tsx", ".py", ".html", ".css", ".sh", ".json", ".yaml", ".yml", ".toml"].includes(ext))
    return FileCodeIcon;
  return FileTextIcon;
}

interface ListViewProps {
  renamingPath: string | null;
  onStartRename: (name: string) => void;
  onCancelRename: () => void;
  onOpenFile?: (path: string) => void;
}

export function ListView({ renamingPath, onStartRename, onCancelRename, onOpenFile }: ListViewProps) {
  const entries = useFileBrowser((s) => s.entries);
  const selectedPaths = useFileBrowser((s) => s.selectedPaths);
  const currentPath = useFileBrowser((s) => s.currentPath);
  const sortBy = useFileBrowser((s) => s.sortBy);
  const sortDirection = useFileBrowser((s) => s.sortDirection);
  const select = useFileBrowser((s) => s.select);
  const setSortBy = useFileBrowser((s) => s.setSortBy);
  const setSortDirection = useFileBrowser((s) => s.setSortDirection);
  const navigate = useFileBrowser((s) => s.navigate);
  const rename = useFileBrowser((s) => s.rename);

  function handleSort(col: "name" | "size" | "modified" | "type") {
    if (sortBy === col) {
      setSortDirection(sortDirection === "asc" ? "desc" : "asc");
    } else {
      setSortBy(col);
      setSortDirection("asc");
    }
  }

  function handleDoubleClick(entry: FileEntry) {
    if (entry.type === "directory") {
      navigate(currentPath ? `${currentPath}/${entry.name}` : entry.name);
    } else {
      onOpenFile?.(currentPath ? `${currentPath}/${entry.name}` : entry.name);
    }
  }

  const SortIcon = sortDirection === "asc" ? ChevronUpIcon : ChevronDownIcon;

  return (
    <div className="overflow-auto h-full" role="grid" aria-label="File list">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-background border-b">
          <tr role="row">
            {(["name", "size", "modified", "type"] as const).map((col) => (
              <th
                key={col}
                className="text-left px-3 py-1.5 font-medium text-muted-foreground cursor-pointer hover:text-foreground select-none"
                onClick={() => handleSort(col)}
              >
                <span className="inline-flex items-center gap-1">
                  {col.charAt(0).toUpperCase() + col.slice(1)}
                  {sortBy === col && <SortIcon className="size-3" />}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => {
            const Icon = getSmallIcon(entry);
            const selected = selectedPaths.has(entry.name);
            return (
              <tr
                key={entry.name}
                role="row"
                className={cn(
                  "cursor-default hover:bg-accent/50 transition-colors",
                  selected && "bg-accent",
                )}
                onClick={(e) => select(entry.name, e.metaKey || e.ctrlKey)}
                onDoubleClick={() => handleDoubleClick(entry)}
              >
                <td className="px-3 py-1 flex items-center gap-2" role="gridcell">
                  <Icon
                    className={cn(
                      "size-4 shrink-0",
                      entry.type === "directory"
                        ? "text-blue-400"
                        : "text-muted-foreground",
                    )}
                  />
                  {renamingPath === entry.name ? (
                    <InlineRename
                      name={entry.name}
                      onCommit={(newName) => {
                        const from = currentPath ? `${currentPath}/${entry.name}` : entry.name;
                        const to = currentPath ? `${currentPath}/${newName}` : newName;
                        rename(from, to);
                        onCancelRename();
                      }}
                      onCancel={onCancelRename}
                    />
                  ) : (
                    <span className="truncate">{entry.name}</span>
                  )}
                </td>
                <td className="px-3 py-1 text-muted-foreground" role="gridcell">
                  {entry.type === "file" ? formatSize(entry.size) : `${entry.children ?? "--"} items`}
                </td>
                <td className="px-3 py-1 text-muted-foreground" role="gridcell">
                  {formatDate(entry.modified)}
                </td>
                <td className="px-3 py-1 text-muted-foreground" role="gridcell">
                  {getTypeLabel(entry)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
