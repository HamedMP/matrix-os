// Git panel: commit DAG graph (primary) + classic branches/PRs view.
// The Graph tab hides itself when the connected gateway predates the
// commit-log endpoints (404) or no runtime is connected, degrading to the
// classic view without an error state.
import { useState } from "react";
import { useConnection } from "../../stores/connection";
import GitGraphView from "./GitGraphView";
import GitRefsPanel from "./GitRefsPanel";
import { useCommitGraph } from "./use-commit-graph";

type GitTab = "graph" | "refs";

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className="rounded px-2 py-0.5 text-[11px] font-medium"
      style={{
        color: active ? "var(--text-primary)" : "var(--text-tertiary)",
        background: active ? "var(--bg-active)" : "transparent",
      }}
    >
      {children}
    </button>
  );
}

export default function GitPanel({ projectSlug }: { projectSlug: string }) {
  const api = useConnection((s) => s.api);
  const graph = useCommitGraph(api, projectSlug);
  const [tab, setTab] = useState<GitTab>("graph");
  const graphAvailable = api != null && graph.supported !== false;
  const activeTab: GitTab = graphAvailable ? tab : "refs";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        role="tablist"
        aria-label="Git panel views"
        className="flex h-8 shrink-0 items-center gap-1 border-b px-2"
        style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
      >
        {graphAvailable ? (
          <TabButton active={activeTab === "graph"} onClick={() => setTab("graph")}>
            Graph
          </TabButton>
        ) : null}
        <TabButton active={activeTab === "refs"} onClick={() => setTab("refs")}>
          Branches
        </TabButton>
      </div>
      {activeTab === "graph" ? <GitGraphView graph={graph} /> : <GitRefsPanel projectSlug={projectSlug} />}
    </div>
  );
}
