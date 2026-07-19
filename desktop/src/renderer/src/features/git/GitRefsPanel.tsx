// Classic branches/PRs/worktrees view — the pre-DAG Git panel content,
// preserved as the fallback surface for gateways without the log endpoints.
import { GitBranch, GitPullRequest, FolderGit2, RefreshCw, Sparkles } from "lucide-react";
import { useEffect } from "react";
import { categoryMessage } from "../../../../shared/app-error";
import { Button, IconButton } from "../../design/primitives";
import { useConnection } from "../../stores/connection";
import { useGit } from "../../stores/git";
import { useUi } from "../../stores/ui";

function SectionHeading({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="mt-3 mb-1 flex items-center gap-1.5 px-1 first:mt-0">
      <span style={{ color: "var(--text-tertiary)" }}>{icon}</span>
      <span className="text-xs font-semibold tracking-wide uppercase" style={{ color: "var(--text-tertiary)" }}>
        {label}
      </span>
    </div>
  );
}

export default function GitRefsPanel({ projectSlug }: { projectSlug: string }) {
  const api = useConnection((s) => s.api);
  const branches = useGit((s) => s.branches);
  const prs = useGit((s) => s.prs);
  const worktrees = useGit((s) => s.worktrees);
  const error = useGit((s) => s.error);
  const loadAll = useGit((s) => s.loadAll);
  const setComposerOpen = useUi((s) => s.setComposerOpen);

  useEffect(() => {
    if (api) void loadAll(api, projectSlug);
  }, [api, loadAll, projectSlug]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-2">
      <div className="flex items-center justify-between px-1">
        <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
          {projectSlug}
        </span>
        <IconButton
          label="Refresh git"
          onClick={() => {
            if (api) void loadAll(api, projectSlug);
          }}
        >
          <RefreshCw size={12} />
        </IconButton>
      </div>

      {error ? (
        <div
          role="status"
          className="mt-2 rounded-lg border px-2.5 py-2 text-xs"
          style={{ borderColor: "var(--danger)", color: "var(--danger)", background: "var(--bg-raised)" }}
        >
          {categoryMessage(error)}
        </div>
      ) : null}

      <SectionHeading icon={<GitBranch size={12} />} label={`Branches (${branches.length})`} />
      {branches.slice(0, 20).map((branch) => (
        <div
          key={branch.name}
          className="truncate rounded px-1.5 py-1 font-mono text-xs"
          style={{ color: "var(--text-secondary)" }}
          title={branch.name}
        >
          {branch.name}
        </div>
      ))}

      <SectionHeading icon={<GitPullRequest size={12} />} label={`Pull requests (${prs.length})`} />
      {prs.slice(0, 20).map((pr) => (
        <div key={pr.number} className="flex items-center gap-1.5 rounded px-1.5 py-1 text-xs">
          <span style={{ color: "var(--text-tertiary)" }}>#{pr.number}</span>
          <span className="truncate" style={{ color: "var(--text-secondary)" }}>
            {pr.title}
          </span>
        </div>
      ))}

      <SectionHeading icon={<FolderGit2 size={12} />} label={`Worktrees (${worktrees.length})`} />
      {worktrees.slice(0, 20).map((worktree, i) => (
        <div
          key={worktree.id ?? i}
          className="truncate rounded px-1.5 py-1 font-mono text-xs"
          style={{ color: "var(--text-secondary)" }}
          title={worktree.path}
        >
          {worktree.currentBranch ?? worktree.sourceBranch ?? worktree.path ?? "worktree"}
        </div>
      ))}

      <div
        className="mt-4 flex flex-col gap-2 rounded-lg border p-3"
        style={{ borderColor: "var(--border-subtle)", background: "var(--bg-raised)" }}
      >
        <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
          Diff review lands with gateway diff support. Meanwhile, ask the agent to review changes.
        </span>
        <Button variant="subtle" onClick={() => setComposerOpen(true)}>
          <Sparkles size={13} />
          Ask agent to review
        </Button>
      </div>
    </div>
  );
}
