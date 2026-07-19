import { ExternalLink, Monitor, RefreshCw } from "lucide-react";
import { useState } from "react";
import type { PreviewSessionSummary, RuntimeSummary } from "@matrix-os/contracts";
import { Button, StatusDot } from "../../design/primitives";
import { invoke } from "../../lib/operator";
import { useCodingAgentWorkspace } from "../../stores/coding-agent-workspace";
import { AgentWorkspaceSection } from "../coding-agents/AgentWorkspaceSection";

const STATUS_COLOR: Record<string, string> = {
  running: "var(--success)",
  starting: "var(--warning)",
  failed: "var(--danger)",
  stopped: "var(--text-tertiary)",
  unknown: "var(--text-tertiary)",
};
const DEFAULT_STATUS_COLOR = "var(--text-tertiary)";

// Mirrors the shell:open-external contract: only HTTPS origins may leave the
// app. Plain-http localhost previews stay inspectable but cannot be opened.
function canOpenExternally(origin: string | undefined): origin is string {
  if (!origin) return false;
  try {
    return new URL(origin).protocol === "https:";
  } catch {
    return false;
  }
}

function openExternalPreview(url: string): void {
  void invoke("shell:open-external", { url }).catch((err: unknown) => {
    console.warn("[coding-agents] preview open failed", err instanceof Error ? err.message : String(err));
  });
}

/**
 * Inspector Preview surface: the session list stays visible; inspecting one
 * adds a chrome row (URL display, refresh, HTTPS-only open-external) above
 * the session's live details. Inline rendering is intentionally not attempted
 * here — the renderer CSP allows no remote frames, and port discovery/device
 * emulation belong to a later wave.
 */
export function InspectorPreviewPanel({ summary }: { summary: RuntimeSummary }) {
  const previews = summary.previewSessions ?? { items: [], hasMore: false, limit: 50 };
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // A refresh that drops the inspected session clears the chrome in the same
  // render — no stale details for a gone preview.
  const selected = selectedId
    ? previews.items.find((candidate) => candidate.id === selectedId) ?? null
    : null;

  return (
    <AgentWorkspaceSection title="Previews" count={previews.items.length}>
      <div className="grid gap-2">
        {previews.items.map((preview) => (
          <button
            key={preview.id}
            type="button"
            aria-label={`Inspect preview ${preview.label}`}
            aria-current={selectedId === preview.id ? "true" : undefined}
            className="no-drag flex min-h-[68px] items-center justify-between gap-3 rounded-md border p-3 text-left transition-colors duration-100 hover:brightness-105"
            style={{
              borderColor: selectedId === preview.id ? "var(--accent)" : "var(--border-subtle)",
              background: selectedId === preview.id ? "var(--accent-muted)" : "var(--bg-surface)",
            }}
            onClick={() => setSelectedId(preview.id)}
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
        {previews.items.length === 0 ? (
          <div
            className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed px-4 py-8 text-center"
            style={{ borderColor: "var(--border-subtle)" }}
          >
            <Monitor size={22} style={{ color: "var(--text-tertiary)" }} />
            <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>No previews yet</p>
            <p className="text-xs" style={{ color: "var(--text-secondary)" }}>
              Previews appear here when an agent serves a web app for this project.
            </p>
          </div>
        ) : null}
        {selected ? <InspectedPreview preview={selected} /> : null}
      </div>
    </AgentWorkspaceSection>
  );
}

function InspectedPreview({ preview }: { preview: PreviewSessionSummary }) {
  const externalUrl = canOpenExternally(preview.origin) ? preview.origin : null;
  return (
    <>
      <div
        className="flex h-9 items-center gap-1 rounded-md border px-1.5"
        style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
      >
        <span
          className="min-w-0 flex-1 truncate px-1.5 font-mono text-xs"
          style={{ color: "var(--text-secondary)" }}
          title={preview.origin ?? undefined}
        >
          {preview.origin ?? "No local origin"}
        </span>
        <button
          type="button"
          aria-label="Refresh previews"
          title="Refresh previews"
          className="no-drag flex h-7 w-7 shrink-0 items-center justify-center rounded-md outline-none transition-colors hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          style={{ color: "var(--text-tertiary)" }}
          onClick={() => void useCodingAgentWorkspace.getState().refresh()}
        >
          <RefreshCw size={13} />
        </button>
        <button
          type="button"
          aria-label="Open preview in browser"
          title={externalUrl ? "Open preview in browser" : "HTTPS preview origin required"}
          disabled={!externalUrl}
          className="no-drag flex h-7 w-7 shrink-0 items-center justify-center rounded-md outline-none transition-colors hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-40"
          style={{ color: "var(--text-tertiary)" }}
          onClick={() => {
            if (externalUrl) openExternalPreview(externalUrl);
          }}
        >
          <ExternalLink size={13} />
        </button>
      </div>
      <section
        aria-label={`Preview details for ${preview.label}`}
        className="rounded-md border p-3"
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
            onClick={() => {
              if (externalUrl) openExternalPreview(externalUrl);
            }}
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
    </>
  );
}
