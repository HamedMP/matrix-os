"use client";

import { useFileBrowser } from "@/hooks/useFileBrowser";
import { XpFolderGlyph } from "./xp-icons";
import { formatXpSize } from "./xp-file-meta";

export function XpStatusBar() {
  const entries = useFileBrowser((s) => s.entries);
  const selectedPaths = useFileBrowser((s) => s.selectedPaths);
  const currentPath = useFileBrowser((s) => s.currentPath);

  const selectedSize = entries
    .filter((e) => selectedPaths.has(e.name) && e.size)
    .reduce((sum, e) => sum + (e.size ?? 0), 0);

  return (
    <div className="xp-status-bar" aria-live="polite">
      <span className="xp-status-cell">
        <XpFolderGlyph size={14} />
        {entries.length} object{entries.length !== 1 ? "s" : ""}
      </span>
      {selectedPaths.size > 0 && (
        <span className="xp-status-cell">
          {selectedPaths.size} selected
          {selectedSize > 0 && ` — ${formatXpSize(selectedSize)}`}
        </span>
      )}
      <span className="xp-status-cell xp-status-right">
        {currentPath === "" ? "Home" : currentPath}
      </span>
    </div>
  );
}
