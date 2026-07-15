import { ExternalLink, Monitor, SquareTerminal } from "lucide-react";
import { useState } from "react";
import type { PreviewSessionSummary, RuntimeSummary } from "@matrix-os/contracts";
import { Button, StatusDot } from "../../design/primitives";
import { invoke } from "../../lib/operator";
import { AgentWorkspaceSection } from "./AgentWorkspaceSection";

const STATUS_COLOR: Record<string, string> = {
  available: "var(--success)",
  running: "var(--success)",
  degraded: "var(--warning)",
  offline: "var(--danger)",
  failed: "var(--danger)",
  unavailable: "var(--danger)",
  unknown: "var(--text-tertiary)",
};
const DEFAULT_STATUS_COLOR = "var(--text-tertiary)";

function canOpenPreviewExternally(origin: string | undefined): origin is string {
  if (!origin) return false;
  try {
    return new URL(origin).protocol === "https:";
  } catch {
    return false;
  }
}

export function AgentTerminalList({ summary }: { summary: RuntimeSummary }) {
  return (
    <AgentWorkspaceSection title="Terminals" count={summary.terminalSessions.items.length}>
      <div className="grid gap-2">
        {summary.terminalSessions.items.map((session) => (
          <article
            key={session.id}
            className="flex items-center justify-between gap-3 rounded-md border p-3"
            style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
          >
            <div className="flex min-w-0 items-center gap-2">
              <SquareTerminal size={15} style={{ color: "var(--text-tertiary)" }} />
              <div className="min-w-0">
                <h3 className="truncate text-sm font-medium" style={{ color: "var(--text-primary)" }}>
                  {session.name}
                </h3>
                <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>
                  {session.attachable ? "Attachable" : "Unavailable"}
                </p>
              </div>
            </div>
            <span className="shrink-0 text-xs capitalize" style={{ color: "var(--text-secondary)" }}>
              {session.status}
            </span>
          </article>
        ))}
        {summary.terminalSessions.items.length === 0 ? (
          <p className="rounded-md border p-3 text-sm" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>
            No terminal sessions.
          </p>
        ) : null}
      </div>
    </AgentWorkspaceSection>
  );
}

export function AgentPreviewList({ summary }: { summary: RuntimeSummary }) {
  const previewSessions = summary.previewSessions ?? { items: [], hasMore: false, limit: 50 };
  const [selectedPreviewId, setSelectedPreviewId] = useState<string | null>(null);
  const selectedPreview = previewSessions.items.find((preview) => preview.id === selectedPreviewId) ?? null;
  const externalUrl = canOpenPreviewExternally(selectedPreview?.origin) ? selectedPreview.origin : null;

  const openExternalPreview = () => {
    if (!externalUrl) return;
    void invoke("shell:open-external", { url: externalUrl }).catch((err: unknown) => {
      console.warn("[coding-agents] preview open failed", err instanceof Error ? err.message : String(err));
    });
  };

  return (
    <AgentWorkspaceSection title="Previews" count={previewSessions.items.length}>
      <div className="grid gap-2">
        {previewSessions.items.map((preview) => (
          <button
            key={preview.id}
            type="button"
            aria-label={`Inspect preview ${preview.label}`}
            aria-current={selectedPreviewId === preview.id ? "true" : undefined}
            className="no-drag flex min-h-[68px] items-center justify-between gap-3 rounded-md border p-3 text-left transition-colors duration-100 hover:brightness-105"
            style={{
              borderColor: selectedPreviewId === preview.id ? "var(--accent)" : "var(--border-subtle)",
              background: selectedPreviewId === preview.id ? "var(--accent-muted)" : "var(--bg-surface)",
            }}
            onClick={() => setSelectedPreviewId(preview.id)}
          >
            <div className="flex min-w-0 items-center gap-2">
              <Monitor size={15} style={{ color: "var(--text-tertiary)" }} />
              <div className="min-w-0">
                <h3 className="truncate text-sm font-medium" style={{ color: "var(--text-primary)" }}>
                  {preview.label}
                </h3>
                <p className="truncate text-xs" style={{ color: "var(--text-tertiary)" }}>
                  {preview.origin ?? "No local origin"}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <StatusDot color={STATUS_COLOR[preview.status] ?? DEFAULT_STATUS_COLOR} />
              <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
                {preview.status}
              </span>
            </div>
          </button>
        ))}
        {previewSessions.items.length === 0 ? (
          <p className="rounded-md border p-3 text-sm" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>
            No previews.
          </p>
        ) : null}
        {selectedPreview ? (
          <PreviewDetails preview={selectedPreview} externalUrl={externalUrl} onOpenExternal={openExternalPreview} />
        ) : null}
      </div>
    </AgentWorkspaceSection>
  );
}

function PreviewDetails({
  preview,
  externalUrl,
  onOpenExternal,
}: {
  preview: PreviewSessionSummary;
  externalUrl: string | null;
  onOpenExternal: () => void;
}) {
  return (
    <section
      className="rounded-md border p-3"
      aria-label={`Preview details for ${preview.label}`}
      style={{ borderColor: "var(--border-subtle)", background: "var(--bg-elevated)" }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
            Preview details
          </h3>
          <p className="mt-1 truncate text-xs" style={{ color: "var(--text-tertiary)" }}>
            {preview.origin ?? "No local origin"}
          </p>
        </div>
        <Button
          variant="ghost"
          onClick={onOpenExternal}
          disabled={!externalUrl}
          aria-label={externalUrl ? `Open preview ${preview.label} in browser` : "Open in browser"}
          title={externalUrl ? "Open in browser" : "HTTPS preview origin required"}
        >
          <ExternalLink size={14} />
          Open in browser
        </Button>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <div>
          <dt style={{ color: "var(--text-tertiary)" }}>Status</dt>
          <dd style={{ color: "var(--text-secondary)" }}>{preview.status}</dd>
        </div>
        <div>
          <dt style={{ color: "var(--text-tertiary)" }}>Updated</dt>
          <dd style={{ color: "var(--text-secondary)" }}>{preview.updatedAt ?? "Unknown"}</dd>
        </div>
      </dl>
    </section>
  );
}
