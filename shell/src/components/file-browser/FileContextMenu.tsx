"use client";

import { useState } from "react";
import { useWebFileDownload } from "./FileDownloadProvider";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useFileBrowser } from "@/hooks/useFileBrowser";

interface FileContextMenuProps {
  children: React.ReactNode;
  targetName?: string;
  targetType?: "file" | "directory";
  onOpenFile?: (path: string) => void;
}

export function FileContextMenu({
  children,
  targetName,
  targetType,
  onOpenFile,
}: FileContextMenuProps) {
  const download = useWebFileDownload();
  const [downloadTarget, setDownloadTarget] = useState<string | null>(null);
  const currentPath = useFileBrowser((s) => s.currentPath);
  const selectedPaths = useFileBrowser((s) => s.selectedPaths);
  const copy = useFileBrowser((s) => s.copy);
  const cut = useFileBrowser((s) => s.cut);
  const paste = useFileBrowser((s) => s.paste);
  const deleteFiles = useFileBrowser((s) => s.deleteFiles);
  const duplicate = useFileBrowser((s) => s.duplicate);
  const createFolder = useFileBrowser((s) => s.createFolder);
  const createFile = useFileBrowser((s) => s.createFile);
  const navigate = useFileBrowser((s) => s.navigate);
  const clipboard = useFileBrowser((s) => s.clipboard);
  const setQuickLookPath = useFileBrowser((s) => s.setQuickLookPath);
  const setViewMode = useFileBrowser((s) => s.setViewMode);
  const setSortBy = useFileBrowser((s) => s.setSortBy);

  const captureDownloadTarget = (event: React.MouseEvent) => {
    const entry = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-web-file-path]") : null;
    setDownloadTarget(entry?.dataset.webFileType === "file" ? entry.dataset.webFilePath ?? null : null);
  };
  const downloadItem = download && downloadTarget ? <ContextMenuItem disabled={download.pending} onSelect={() => download.download(downloadTarget)}>Download</ContextMenuItem> : null;

  const isMulti = selectedPaths.size > 1;
  const selected = Array.from(selectedPaths);
  const fullPaths = selected.map((n) =>
    currentPath ? `${currentPath}/${n}` : n,
  );

  if (isMulti) {
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild onContextMenuCapture={captureDownloadTarget}>{children}</ContextMenuTrigger>
        <ContextMenuContent>
          {downloadItem}
          <ContextMenuItem onClick={() => copy(fullPaths)}>Copy</ContextMenuItem>
          <ContextMenuItem onClick={() => cut(fullPaths)}>Cut</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            className="text-destructive"
            onClick={() => deleteFiles(fullPaths)}
          >
            Move to Trash
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  }

  if (targetName && targetType) {
    const fullPath = currentPath
      ? `${currentPath}/${targetName}`
      : targetName;

    return (
      <ContextMenu>
        <ContextMenuTrigger asChild onContextMenuCapture={captureDownloadTarget}>{children}</ContextMenuTrigger>
        <ContextMenuContent>
          {downloadItem}
          {targetType === "directory" ? (
            <ContextMenuItem
              onClick={() => navigate(fullPath)}
            >
              Open
            </ContextMenuItem>
          ) : (
            <>
              <ContextMenuItem onClick={() => onOpenFile?.(fullPath)}>
                Open
              </ContextMenuItem>
              <ContextMenuItem onClick={() => setQuickLookPath(targetName)}>
                Quick Look
              </ContextMenuItem>
            </>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => copy([fullPath])}>Copy</ContextMenuItem>
          <ContextMenuItem onClick={() => cut([fullPath])}>Cut</ContextMenuItem>
          <ContextMenuItem onClick={() => duplicate([fullPath])}>
            Duplicate
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            onClick={() => navigator.clipboard.writeText(fullPath)}
          >
            Copy Path
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            className="text-destructive"
            onClick={() => deleteFiles([fullPath])}
          >
            Move to Trash
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  }

  // Empty space context menu
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild onContextMenuCapture={captureDownloadTarget}>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        {downloadItem}
        <ContextMenuSub>
          <ContextMenuSubTrigger>New File</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {[".md", ".txt", ".json", ".html", ".js", ".ts"].map((ext) => (
              <ContextMenuItem
                key={ext}
                onClick={() => createFile(`untitled${ext}`)}
              >
                {ext}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuItem onClick={() => createFolder("New Folder")}>
          New Folder
        </ContextMenuItem>
        {clipboard && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => paste()}>Paste</ContextMenuItem>
          </>
        )}
        <ContextMenuSeparator />
        <ContextMenuSub>
          <ContextMenuSubTrigger>Sort By</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {(["name", "size", "modified", "type"] as const).map((s) => (
              <ContextMenuItem key={s} onClick={() => setSortBy(s)}>
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSub>
          <ContextMenuSubTrigger>View As</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {(["icon", "list", "column"] as const).map((v) => (
              <ContextMenuItem key={v} onClick={() => setViewMode(v)}>
                {v.charAt(0).toUpperCase() + v.slice(1)}s
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
      </ContextMenuContent>
    </ContextMenu>
  );
}
