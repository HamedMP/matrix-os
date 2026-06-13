import { ExternalLink, Globe, RefreshCw } from "lucide-react";
import { useEffect } from "react";
import { EmptyState, IconButton, StatusDot } from "../../design/primitives";
import { invoke } from "../../lib/operator";
import { useConnection } from "../../stores/connection";
import { useGit } from "../../stores/git";

const HEALTH_COLOR: Record<string, string> = {
  ok: "var(--success)",
  failed: "var(--danger)",
  unknown: "var(--text-tertiary)",
};

export default function ArtifactsPanel({
  projectSlug,
  taskId,
}: {
  projectSlug: string;
  taskId: string;
}) {
  const api = useConnection((s) => s.api);
  const allPreviews = useGit((s) => s.previews);
  const loadPreviews = useGit((s) => s.loadPreviews);
  const previews = allPreviews.filter((p) => p.taskId === taskId);

  useEffect(() => {
    if (api) void loadPreviews(api, projectSlug, taskId);
  }, [api, loadPreviews, projectSlug, taskId]);

  const openPreview = (url: string | undefined) => {
    if (url && url.startsWith("https://")) void invoke("shell:open-external", { url });
  };

  if (previews.length === 0) {
    return (
      <EmptyState
        icon={<Globe size={22} />}
        headline="No previews"
        description="Preview URLs exposed by this task's session appear here with a health check."
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2">
      <div className="flex items-center justify-end">
        <IconButton
          label="Refresh previews"
          onClick={() => {
            if (api) void loadPreviews(api, projectSlug, taskId);
          }}
        >
          <RefreshCw size={12} />
        </IconButton>
      </div>
      {previews.slice(0, 50).map((preview) => {
        const openable = Boolean(preview.url && preview.url.startsWith("https://"));
        return (
          <button
            key={preview.id}
            type="button"
            disabled={!openable}
            className="group/preview flex items-center gap-2.5 rounded-lg border p-2.5 text-left transition-colors hover:border-[var(--border-strong)] disabled:cursor-default"
            style={{ borderColor: "var(--border-subtle)", background: "var(--bg-raised)" }}
            onClick={() => openPreview(preview.url)}
          >
            <StatusDot color={HEALTH_COLOR[preview.lastStatus ?? "unknown"] ?? "var(--text-tertiary)"} />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm" style={{ color: "var(--text-primary)" }}>{preview.label ?? preview.id}</span>
              {preview.url ? (
                <span className="truncate text-xs" style={{ color: "var(--text-tertiary)" }}>{preview.url}</span>
              ) : null}
            </div>
            {openable ? (
              <ExternalLink size={13} className="opacity-0 transition-opacity group-hover/preview:opacity-100" style={{ color: "var(--text-tertiary)" }} />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
