"use client";

import { useFileBrowser, type FileEntry } from "@/hooks/useFileBrowser";
import { usePreviewWindow } from "@/hooks/usePreviewWindow";
import { FileIcon } from "./FileIcon";
import { InlineRename } from "./InlineRename";

interface IconViewProps {
  renamingPath: string | null;
  onStartRename: (name: string) => void;
  onCancelRename: () => void;
}

export function IconView({ renamingPath, onStartRename, onCancelRename }: IconViewProps) {
  const entries = useFileBrowser((s) => s.entries);
  const selectedPaths = useFileBrowser((s) => s.selectedPaths);
  const currentPath = useFileBrowser((s) => s.currentPath);
  const select = useFileBrowser((s) => s.select);
  const navigate = useFileBrowser((s) => s.navigate);
  const rename = useFileBrowser((s) => s.rename);
  const openFile = usePreviewWindow((s) => s.openFile);

  function handleClick(entry: FileEntry, e: React.MouseEvent) {
    select(entry.name, e.metaKey || e.ctrlKey);
  }

  function handleDoubleClick(entry: FileEntry) {
    if (entry.type === "directory") {
      navigate(currentPath ? `${currentPath}/${entry.name}` : entry.name);
    } else {
      openFile(currentPath ? `${currentPath}/${entry.name}` : entry.name);
    }
  }

  return (
    <div
      className="grid gap-1 p-2 content-start"
      style={{ gridTemplateColumns: "repeat(auto-fill, 96px)" }}
      role="grid"
      aria-label="File list"
    >
      {entries.map((entry) => (
        <FileIcon
          key={entry.name}
          name={entry.name}
          type={entry.type}
          selected={selectedPaths.has(entry.name)}
          onClick={(e) => handleClick(entry, e)}
          onDoubleClick={() => handleDoubleClick(entry)}
          renaming={
            renamingPath === entry.name ? (
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
            ) : undefined
          }
        />
      ))}
    </div>
  );
}
