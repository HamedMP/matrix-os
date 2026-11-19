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
  onOpenFile?: (path: string) => void;
}

type FileContextTarget = { path: string; type: "file" | "directory"; paths: string[] };

export function FileContextMenu({ children, onOpenFile }: FileContextMenuProps) {
  const download = useWebFileDownload();
  const [target, setTarget] = useState<FileContextTarget | null>(null);
  const currentPath = useFileBrowser((s) => s.currentPath);
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

  const captureTarget = (event: React.MouseEvent) => {
    const entry = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-web-file-path]") : null;
    const path = entry?.dataset.webFilePath;
    const type = entry?.dataset.webFileType;
    if (!entry || !event.currentTarget.contains(entry) || !path || (type !== "file" && type !== "directory")) {
      setTarget(null);
      return;
    }

    // Capture the visible selection now so it cannot change under an open menu.
    const paths = [path];
    if (entry.dataset.webFileSelected === "true") {
      const selectedRows = event.currentTarget.querySelectorAll<HTMLElement>('[data-web-file-selected="true"]');
      for (const row of selectedRows) {
        const selectedPath = row.dataset.webFilePath;
        if (selectedPath && selectedPath !== path) paths.push(selectedPath);
      }
    }
    setTarget({ path, type, paths });
  };

  const targetName = target?.path.split("/").at(-1);
  const inCurrentFolder = target && targetName && target.path === (currentPath ? `${currentPath}/${targetName}` : targetName);
  const isMulti = target && target.paths.length > 1;

  return (
    <ContextMenu>
      <ContextMenuTrigger
        asChild
        onContextMenuCapture={captureTarget}
        onPointerDownCapture={event => { if (event.pointerType !== "mouse") captureTarget(event); }}
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent>
        {target ? (
          <>
            {download && target.type === "file" ? (
              <ContextMenuItem disabled={download.pending} onSelect={() => download.download(target.path)}>Download</ContextMenuItem>
            ) : null}
            {!isMulti ? (
              <>
                <ContextMenuItem onSelect={() => {
                  if (target.type === "directory") navigate(target.path);
                  else onOpenFile?.(target.path);
                }}>Open</ContextMenuItem>
                {target.type === "file" && inCurrentFolder ? (
                  <ContextMenuItem onSelect={() => setQuickLookPath(targetName)}>Quick Look</ContextMenuItem>
                ) : null}
                <ContextMenuSeparator />
              </>
            ) : null}
            <ContextMenuItem onSelect={() => copy(target.paths)}>Copy</ContextMenuItem>
            <ContextMenuItem onSelect={() => cut(target.paths)}>Cut</ContextMenuItem>
            {!isMulti ? (
              <>
                <ContextMenuItem onSelect={() => duplicate(target.paths)}>Duplicate</ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => navigator.clipboard.writeText(target.path)}>Copy Path</ContextMenuItem>
              </>
            ) : null}
            <ContextMenuSeparator />
            <ContextMenuItem className="text-destructive" onSelect={() => deleteFiles(target.paths)}>
              Move to Trash
            </ContextMenuItem>
          </>
        ) : (
          <>
            <ContextMenuSub>
              <ContextMenuSubTrigger>New File</ContextMenuSubTrigger>
              <ContextMenuSubContent>
                {[".md", ".txt", ".json", ".html", ".js", ".ts"].map((ext) => (
                  <ContextMenuItem key={ext} onClick={() => createFile(`untitled${ext}`)}>{ext}</ContextMenuItem>
                ))}
              </ContextMenuSubContent>
            </ContextMenuSub>
            <ContextMenuItem onClick={() => createFolder("New Folder")}>New Folder</ContextMenuItem>
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
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
