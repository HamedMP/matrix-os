// Graph tab body: toolbar + virtualized commit DAG + selected-commit detail.
// All data flows through the CommitGraphController owned by GitPanel so the
// tab bar can hide this surface when the gateway lacks the log endpoints.
import { GitGraph as GitGraphIcon, RefreshCw } from "lucide-react";
import { categoryMessage } from "../../../../shared/app-error";
import { EmptyState, IconButton } from "../../design/primitives";
import GitCommitDetail from "./GitCommitDetail";
import { GitGraph } from "./GitGraph";
import type { CommitGraphController } from "./use-commit-graph";

export default function GitGraphView({ graph }: { graph: CommitGraphController }) {
  const selectedCommit = graph.selectedSha
    ? graph.commits.find((commit) => commit.sha === graph.selectedSha) ?? null
    : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-7 shrink-0 items-center justify-between px-2">
        <span className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>
          {graph.commits.length > 0 ? `${graph.commits.length.toLocaleString()} commits` : "History"}
        </span>
        <IconButton label="Refresh history" onClick={() => graph.refresh()}>
          <RefreshCw size={12} />
        </IconButton>
      </div>
      {graph.status === "loading" && graph.commits.length === 0 ? (
        <div role="status" className="flex flex-1 items-center justify-center px-4 text-xs" style={{ color: "var(--text-tertiary)" }}>
          Loading history…
        </div>
      ) : graph.status === "error" && graph.commits.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4">
          <div role="status" className="text-center text-xs" style={{ color: "var(--danger)" }}>
            {categoryMessage(graph.error ?? "server")}
          </div>
          <button
            type="button"
            onClick={() => graph.refresh()}
            className="text-xs font-medium"
            style={{ color: "var(--accent)" }}
          >
            Retry
          </button>
        </div>
      ) : graph.commits.length === 0 ? (
        <EmptyState
          icon={<GitGraphIcon size={20} />}
          headline="No commits yet"
          description="This project has no git history to graph. Commit some work and refresh."
        />
      ) : (
        <GitGraph
          commits={graph.commits}
          selectedSha={graph.selectedSha}
          onSelect={(sha) => graph.selectCommit(sha === graph.selectedSha ? null : sha)}
          hasMore={graph.nextCursor != null && !graph.capped}
          capped={graph.capped}
          loadingMore={graph.loadingMore}
          onLoadMore={() => graph.loadMore()}
        />
      )}
      {graph.error && graph.commits.length > 0 ? (
        <div role="status" className="shrink-0 px-3 py-1 text-[10px]" style={{ color: "var(--danger)" }}>
          {categoryMessage(graph.error)}
        </div>
      ) : null}
      {selectedCommit ? (
        <GitCommitDetail
          commit={selectedCommit}
          diff={graph.diff}
          diffStatus={graph.diffStatus}
          diffError={graph.diffError}
          onClose={() => graph.selectCommit(null)}
        />
      ) : null}
    </div>
  );
}
