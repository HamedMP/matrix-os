import type { SharedAppDirectoryControls } from "./useSharedAppDirectory.js";

export function SharedAppDirectoryNotice({ directory }: { directory: SharedAppDirectoryControls }) {
  if (!directory.unavailable && !directory.hasMore && !directory.hasEarlier && !directory.loading) return null;
  return <div role="status" className="mx-4 my-2 flex flex-wrap items-center justify-center gap-3 rounded-lg border bg-background px-3 py-2 text-sm text-foreground">
    {directory.loading && !directory.hasMore ? <span>Loading shared apps…</span> : null}
    {directory.unavailable ? <><span>Shared apps are unavailable.</span>
      <button type="button" onClick={directory.retry} disabled={directory.loading} className="rounded px-2 py-1 underline hover:bg-accent focus-visible:outline-2">Retry</button></> : null}
    {directory.hasEarlier ? <><span>Earlier shared apps are hidden to keep the launcher responsive.</span>
      <button type="button" onClick={directory.restart} className="rounded px-2 py-1 underline hover:bg-accent focus-visible:outline-2">Show first shared apps</button></> : null}
    {directory.hasMore ? <button type="button" onClick={directory.loadMore} disabled={directory.loading} className="rounded px-2 py-1 underline hover:bg-accent focus-visible:outline-2">
      {directory.loading ? "Loading shared apps…" : "Load more shared apps"}
    </button> : null}
  </div>;
}
