"use client";

import { useFileBrowser, type FileEntry } from "@/hooks/useFileBrowser";
import { InlineRename } from "./InlineRename";
import { XpFileGlyph, XpFolderGlyph } from "./xp-icons";
import { formatXpSize, xpFileMarkColor, xpTypeLabel } from "./xp-file-meta";

interface XpTilesViewProps {
  renamingPath: string | null;
  onCancelRename: () => void;
  onOpenFile?: (path: string) => void;
}

export function XpTilesView({ renamingPath, onCancelRename, onOpenFile }: XpTilesViewProps) {
  const entries = useFileBrowser((s) => s.entries);
  const selectedPaths = useFileBrowser((s) => s.selectedPaths);
  const currentPath = useFileBrowser((s) => s.currentPath);
  const select = useFileBrowser((s) => s.select);
  const navigate = useFileBrowser((s) => s.navigate);
  const rename = useFileBrowser((s) => s.rename);

  function handleDoubleClick(entry: FileEntry) {
    if (entry.type === "directory") {
      navigate(currentPath ? `${currentPath}/${entry.name}` : entry.name);
    } else {
      onOpenFile?.(currentPath ? `${currentPath}/${entry.name}` : entry.name);
    }
  }

  return (
    <div className="xp-tiles" role="grid" aria-label="File list">
      {entries.map((entry) => {
        const selected = selectedPaths.has(entry.name);
        return (
          <div
            key={entry.name}
            className={selected ? "xp-tile xp-tile-selected" : "xp-tile"}
            // react-doctor-disable-next-line react-doctor/prefer-tag-over-role -- gridcell in a CSS grid (role="grid"); no native HTML element maps to the ARIA gridcell role
            role="gridcell"
            // react-doctor-disable-next-line react-doctor/no-noninteractive-tabindex -- focus target so Enter/Space keyboard parity with the classic IconView works per tile
            tabIndex={0}
            aria-selected={selected}
            onClick={(e) => select(entry.name, e.metaKey || e.ctrlKey)}
            onDoubleClick={() => handleDoubleClick(entry)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleDoubleClick(entry);
              } else if (e.key === " ") {
                e.preventDefault();
                select(entry.name, e.metaKey || e.ctrlKey);
              }
            }}
          >
            <span className="xp-tile-glyph">
              {entry.type === "directory" ? (
                <XpFolderGlyph size={48} />
              ) : (
                <XpFileGlyph size={48} color={xpFileMarkColor(entry.name)} />
              )}
            </span>
            <span className="xp-tile-text">
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
                <span className="xp-tile-name" title={entry.name}>
                  {entry.name}
                </span>
              )}
              <span className="xp-tile-detail">{xpTypeLabel(entry)}</span>
              {entry.type === "file" && entry.size !== undefined && (
                <span className="xp-tile-detail">{formatXpSize(entry.size)}</span>
              )}
              {entry.type === "directory" && entry.children !== undefined && (
                <span className="xp-tile-detail">{entry.children} items</span>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
