"use client";

import { useFileBrowser } from "@/hooks/useFileBrowser";

export function StatusBar() {
  const entries = useFileBrowser((s) => s.entries);
  const selectedPaths = useFileBrowser((s) => s.selectedPaths);

  const dirs = entries.filter((e) => e.type === "directory").length;
  const files = entries.filter((e) => e.type === "file").length;
  const selectedSize = entries
    .filter((e) => selectedPaths.has(e.name) && e.size)
    .reduce((sum, e) => sum + (e.size ?? 0), 0);

  return (
    <div
      className="flex items-center justify-between px-3 py-1 text-xs text-muted-foreground border-t border-border bg-background/80"
      aria-live="polite"
    >
      <span>
        {entries.length} items
        {dirs > 0 && ` \u2014 ${dirs} folder${dirs !== 1 ? "s" : ""}`}
        {files > 0 && `, ${files} file${files !== 1 ? "s" : ""}`}
      </span>
      {selectedPaths.size > 0 && (
        <span>
          {selectedPaths.size} selected
          {selectedSize > 0 && ` \u2014 ${formatBytes(selectedSize)}`}
        </span>
      )}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
