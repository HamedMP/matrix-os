import { ExternalLink, Globe, RefreshCw } from "lucide-react";
import { useEffect } from "react";
import { categoryMessage } from "../../../../shared/app-error";
import { EmptyState, IconButton, StatusDot } from "../../design/primitives";
import { invoke } from "../../lib/operator";
import { useConnection } from "../../stores/connection";
import { useGit } from "../../stores/git";

export function canOpenPreviewUrl(url: string | null | undefined): url is string {
  return typeof url === "string" && url.startsWith("https://");
}

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
  const previewScope = useGit((s) => s.previewScope);
  const previewError = useGit((s) => s.previewError);
  const loadPreviews = useGit((s) => s.loadPreviews);

  useEffect(() => {
    if (api) void loadPreviews(api, projectSlug, taskId);
  }, [api, loadPreviews, projectSlug, taskId]);

  const scopeMatches = previewScope?.projectSlug === projectSlug && previewScope.taskId === taskId;
  const scopedPreviews = allPreviews.filter(
    (preview) => preview.projectSlug === projectSlug && preview.taskId === taskId,
  );
  const openPreview = (url: string | undefined) => {
    if (canOpenPreviewUrl(url)) void invoke("shell:open-external", { url });
  };

  if (scopeMatches && previewError && scopedPreviews.length === 0) {
    return (
      <EmptyState
        icon={<Globe size={22} />}
        headline="Couldn't load previews"
        description={categoryMessage(previewError)}
      />
    );
  }

  if (scopedPreviews.length === 0) {
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
      {scopedPreviews.slice(0, 50).map((preview) => {
        const openable = canOpenPreviewUrl(preview.url);
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
              <span className="truncate text-sm" style={{ color: "var(--text-primary)" }}>
                {preview.label ?? preview.id}
              </span>
              {preview.url ? (
                <span className="truncate text-xs" style={{ color: "var(--text-tertiary)" }}>
                  {preview.url}
                </span>
              ) : null}
            </div>
            {openable ? (
              <ExternalLink
                size={13}
                className="opacity-0 transition-opacity group-hover/preview:opacity-100"
                style={{ color: "var(--text-tertiary)" }}
              />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
