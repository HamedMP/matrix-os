"use client";

import { FolderOpenIcon, Loader2Icon } from "lucide-react";
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
      <div className="flex items-center justify-center gap-2 h-full text-muted-foreground text-sm">
        <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
        Loading...
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 px-6 text-center">
        <span className="inline-flex size-12 items-center justify-center rounded-2xl bg-foreground/5 text-muted-foreground/60">
          <FolderOpenIcon className="size-6" aria-hidden="true" />
        </span>
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground/80">Empty folder</p>
          <p className="text-xs text-muted-foreground">Nothing here yet</p>
        </div>
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
