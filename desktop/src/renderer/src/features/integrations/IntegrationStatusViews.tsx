// Full-section status views: loading skeleton, the capability-gated
// "unavailable on this runtime" empty state, the generic offline/error
// state with retry, and the empty-catalog state.
import { Plug } from "lucide-react";
import { Button } from "../../design/primitives";

export function LoadingSkeleton() {
  return (
    <div data-testid="integrations-loading" className="flex flex-col gap-3" aria-label="Loading integrations">
      {[0, 1, 2].map((row) => (
        <div key={row} className="h-16 animate-pulse rounded-xl" style={{ background: "var(--bg-surface)" }} />
      ))}
    </div>
  );
}

export function UnavailableState() {
  return (
    <div
      data-testid="integrations-unavailable"
      className="flex flex-col items-center gap-2 rounded-xl border p-8 text-center"
      style={{ background: "var(--bg-surface)", borderColor: "var(--border-subtle)" }}
    >
      <Plug size={20} style={{ color: "var(--text-tertiary)" }} />
      <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
        Integrations are unavailable on this runtime.
      </p>
      <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>
        This computer's gateway does not expose the integrations API.
      </p>
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      className="flex flex-col items-center gap-3 rounded-xl border p-8 text-center"
      style={{ background: "var(--bg-surface)", borderColor: "var(--border-subtle)" }}
    >
      <p className="text-sm" style={{ color: "var(--text-primary)" }}>
        {message}
      </p>
      <Button onClick={onRetry}>Retry</Button>
    </div>
  );
}

export function EmptyCatalogState() {
  return (
    <div
      className="flex flex-col items-center gap-2 rounded-xl border p-8 text-center"
      style={{ background: "var(--bg-surface)", borderColor: "var(--border-subtle)" }}
    >
      <Plug size={20} style={{ color: "var(--text-tertiary)" }} />
      <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
        No integrations are available yet.
      </p>
    </div>
  );
}
