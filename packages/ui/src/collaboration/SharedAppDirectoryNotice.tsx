export function SharedAppDirectoryNotice({ unavailable, onRetry }: { unavailable: boolean; onRetry(): void }) {
  if (!unavailable) return null;
  return <div role="status" className="mx-4 my-2 flex items-center justify-center gap-3 rounded-lg border bg-background px-3 py-2 text-sm text-foreground">
    <span>Shared apps are unavailable.</span>
    <button type="button" onClick={onRetry} className="rounded px-2 py-1 underline hover:bg-accent focus-visible:outline-2">Retry</button>
  </div>;
}
