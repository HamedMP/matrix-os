"use client";
import { useEffect, useState } from "react";
import { FileCode2 } from "lucide-react";
import { z } from "zod/v4";

const SearchResponse = z.object({
  results: z.array(z.object({ path: z.string().max(4096), name: z.string().max(255), type: z.enum(["file", "directory"]) })).max(500),
  truncated: z.boolean(),
});
type Result = z.infer<typeof SearchResponse>["results"][number];
export function WebChatFileSearch({ gatewayUrl, rootPath, query, onOpenFile }: {
  gatewayUrl: string; rootPath: string; query: string; onOpenFile(path: string): void;
}) {
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<{ query: string; status: "ready" | "error"; results: Result[]; truncated: boolean } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ q: query, path: rootPath, limit: "200" });
      void fetch(`${gatewayUrl}/api/files/search?${params}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) })
        .then(async response => {
          if (!response.ok) throw new Error("FileSearchUnavailable");
          return SearchResponse.parse(await response.json());
        })
        .then(data => {
          if (controller.signal.aborted) return;
          const results = data.results.slice(0, 200).filter(entry => entry.type === "file" && !entry.path.startsWith("/")
            && !entry.path.includes("\\") && !entry.path.split("/").some(part => part === ".." || part === ".")
            && (!rootPath || entry.path.startsWith(`${rootPath}/`)));
          setState({ query, status: "ready", results, truncated: data.truncated });
        })
        .catch((cause: unknown) => {
          if (controller.signal.aborted) return;
          console.warn("[chat-inspector] File search unavailable:", cause instanceof Error ? cause.name : "UnknownError");
          setState({ query, status: "error", results: [], truncated: false });
        });
    }, 150);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [gatewayUrl, rootPath, query, retry]);
  if (state?.query !== query) return <p role="status" className="px-3 py-1 text-xs text-muted-foreground">Searching files…</p>;
  if (state.status === "error") return <p role="alert" className="px-3 py-1 text-xs">Files could not be searched. <button type="button" className="underline" onClick={() => { setState(null); setRetry(value => value + 1); }}>Retry</button></p>;
  return <div aria-label="Matching chat files">
    {state.results.length === 0 ? <p className="px-3 py-1 text-xs text-muted-foreground">No matching files.</p> : null}
    {state.results.map(entry => <button key={entry.path} type="button" aria-label={`Open search result ${rootPath ? entry.path.slice(rootPath.length + 1) : entry.path}`}
      className="flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-3 text-left text-sm hover:bg-accent" onClick={() => onOpenFile(entry.path)}>
      <FileCode2 size={14} aria-hidden/><span className="truncate" title={entry.path}>{rootPath ? entry.path.slice(rootPath.length + 1) : entry.path}</span>
    </button>)}
    {state.truncated ? <p role="status" className="px-3 py-1 text-xs text-muted-foreground">More matches are available. Refine the filter.</p> : null}
  </div>;
}
