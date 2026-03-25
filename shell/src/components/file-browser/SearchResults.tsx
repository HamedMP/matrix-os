"use client";

import { useFileBrowser, type SearchResult } from "@/hooks/useFileBrowser";
import {
  FileTextIcon,
  FolderIcon,
  FileCodeIcon,
} from "lucide-react";

interface SearchResultsProps {
  onOpenFile?: (path: string) => void;
}

export function SearchResults({ onOpenFile }: SearchResultsProps) {
  const searchResults = useFileBrowser((s) => s.searchResults);
  const searchQuery = useFileBrowser((s) => s.searchQuery);
  const searching = useFileBrowser((s) => s.searching);
  const navigate = useFileBrowser((s) => s.navigate);
  const select = useFileBrowser((s) => s.select);
  const clearSearch = useFileBrowser((s) => s.clearSearch);

  if (!searchResults) return null;

  if (searching) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        Searching...
      </div>
    );
  }

  if (searchResults.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2">
        <div className="text-lg">No results</div>
        <div className="text-xs">No files matching &quot;{searchQuery}&quot;</div>
      </div>
    );
  }

  function handleClick(result: SearchResult) {
    const parentPath = result.path.includes("/")
      ? result.path.slice(0, result.path.lastIndexOf("/"))
      : "";
    clearSearch();
    navigate(parentPath);
    select(result.name);
  }

  function handleDoubleClick(result: SearchResult) {
    if (result.type === "directory") {
      clearSearch();
      navigate(result.path);
    } else {
      onOpenFile?.(result.path);
    }
  }

  return (
    <div className="overflow-auto h-full">
      <div className="px-3 py-2 text-xs text-muted-foreground border-b">
        {searchResults.length} result{searchResults.length !== 1 ? "s" : ""}{" "}
        for &quot;{searchQuery}&quot;
      </div>
      {searchResults.map((result) => (
        <div
          key={result.path}
          className="flex items-start gap-2 px-3 py-2 hover:bg-accent/50 cursor-default border-b border-border/30"
          onClick={() => handleClick(result)}
          onDoubleClick={() => handleDoubleClick(result)}
        >
          {result.type === "directory" ? (
            <FolderIcon className="size-4 text-blue-400 shrink-0 mt-0.5" />
          ) : isCode(result.name) ? (
            <FileCodeIcon className="size-4 text-muted-foreground shrink-0 mt-0.5" />
          ) : (
            <FileTextIcon className="size-4 text-muted-foreground shrink-0 mt-0.5" />
          )}
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium truncate">{result.name}</div>
            <div className="text-xs text-muted-foreground truncate">
              {result.path}
            </div>
            {result.matches
              .filter((m) => m.type === "content")
              .slice(0, 2)
              .map((m, i) => (
                <div
                  key={i}
                  className="text-xs text-muted-foreground mt-0.5 truncate"
                >
                  <span className="text-muted-foreground/60">
                    {m.line}:
                  </span>{" "}
                  {m.text}
                </div>
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function isCode(name: string): boolean {
  return /\.(js|ts|jsx|tsx|py|html|css|sh|json|yaml|yml|toml)$/i.test(name);
}
