import { Package, RefreshCw } from "lucide-react";
import { useEffect } from "react";
import { categoryMessage } from "../../../../shared/app-error";
import { EmptyState, IconButton } from "../../design/primitives";
import { invoke } from "../../lib/operator";
import { useConnection } from "../../stores/connection";
import { useGit } from "../../stores/git";

export function canOpenPreviewUrl(url: string | null | undefined): url is string {
  return typeof url === "string" && url.startsWith("https://");
}

export default function ArtifactsPanel({
  projectSlug,
  taskId,
}: {
  projectSlug: string;
  taskId: string;
}) {
  const api = useConnection((s) => s.api);
  const previews = useGit((s) => s.previews);
  const previewScope = useGit((s) => s.previewScope);
  const error = useGit((s) => s.error);
  const loadPreviews = useGit((s) => s.loadPreviews);

  useEffect(() => {
    if (api) void loadPreviews(api, projectSlug, taskId);
  }, [api, loadPreviews, projectSlug, taskId]);

  const scopedPreviews =
    previewScope?.projectSlug === projectSlug && previewScope.taskId === taskId ? previews : [];

  if (error && scopedPreviews.length === 0) {
    return (
      <EmptyState
        icon={<Package size={22} />}
        headline="Couldn't load artifacts"
        description={categoryMessage(error)}
      />
    );
  }

  if (scopedPreviews.length === 0) {
    return (
      <EmptyState
        icon={<Package size={22} />}
        headline="No artifacts"
        description="Previews and artifacts created on this task appear here."
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2">
      <div className="flex items-center justify-end">
        <IconButton
          label="Refresh artifacts"
          onClick={() => {
            if (api) void loadPreviews(api, projectSlug, taskId);
          }}
        >
          <RefreshCw size={12} />
        </IconButton>
      </div>
      {scopedPreviews.slice(0, 50).map((preview) => (
        <button
          key={preview.id}
          type="button"
          className="flex flex-col gap-0.5 rounded-lg border p-2.5 text-left hover:border-[var(--border-strong)]"
          style={{ borderColor: "var(--border-subtle)", background: "var(--bg-raised)" }}
          onClick={() => {
            if (canOpenPreviewUrl(preview.url)) {
              void invoke("shell:open-external", { url: preview.url });
            }
          }}
        >
          <span className="truncate text-sm" style={{ color: "var(--text-primary)" }}>
            {preview.label ?? preview.id}
          </span>
          {preview.url ? (
            <span className="truncate text-xs" style={{ color: "var(--text-tertiary)" }}>
              {preview.url}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
