"use client";

import { useFileBrowser } from "@/hooks/useFileBrowser";
import { IconView } from "./IconView";
import { ListView } from "./ListView";
import { ColumnView } from "./ColumnView";

interface FileBrowserContentProps {
  renamingPath: string | null;
  onStartRename: (name: string) => void;
  onCancelRename: () => void;
  onOpenFile?: (path: string) => void;
}

export function FileBrowserContent({
  renamingPath,
  onStartRename,
  onCancelRename,
  onOpenFile,
}: FileBrowserContentProps) {
  const viewMode = useFileBrowser((s) => s.viewMode);
  const loading = useFileBrowser((s) => s.loading);
  const entries = useFileBrowser((s) => s.entries);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        Loading...
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2">
        <div className="text-lg">Empty folder</div>
        <div className="text-xs">Right-click to create a file or folder</div>
      </div>
    );
  }

  switch (viewMode) {
    case "icon":
      return (
        <IconView
          renamingPath={renamingPath}
          onStartRename={onStartRename}
          onCancelRename={onCancelRename}
          onOpenFile={onOpenFile}
        />
      );
    case "list":
      return (
        <ListView
          renamingPath={renamingPath}
          onStartRename={onStartRename}
          onCancelRename={onCancelRename}
          onOpenFile={onOpenFile}
        />
      );
    case "column":
      return <ColumnView onOpenFile={onOpenFile} />;
    default:
      return null;
  }
}
