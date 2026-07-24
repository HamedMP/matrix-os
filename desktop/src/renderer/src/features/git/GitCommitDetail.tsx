// Selected-commit detail: message/author/meta plus the bounded changed-file
// list from the gateway diff endpoint, with an expandable unified-diff view
// per file (+/- coloring, client-side render cap on top of the server caps).
import { useState } from "react";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import { categoryMessage, type AppErrorCategory } from "../../../../shared/app-error";
import { IconButton } from "../../design/primitives";
import type { CommitDiffFile, CommitDiffState, CommitSummary } from "./graph-types";
import { relativeTime } from "./relative-time";
import type { CommitGraphStatus } from "./use-commit-graph";

// Client render cap on top of the server-side per-file line cap.
const MAX_RENDER_LINES = 800;

type DiffLineKind = "add" | "del" | "hunk" | "meta" | "context";

export function diffLineKind(line: string): DiffLineKind {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  if (line.startsWith("\\")) return "meta";
  return "context";
}

const DIFF_LINE_STYLE: Record<DiffLineKind, { color: string; background?: string }> = {
  add: { color: "var(--success)", background: "var(--success-muted)" },
  del: { color: "var(--danger)", background: "var(--danger-muted)" },
  hunk: { color: "var(--text-tertiary)", background: "var(--bg-raised)" },
  meta: { color: "var(--text-tertiary)" },
  context: { color: "var(--text-secondary)" },
};

function statusColor(status: string): string {
  if (status === "A") return "var(--success)";
  if (status === "D") return "var(--danger)";
  if (status === "R" || status === "C") return "var(--info)";
  return "var(--warning)";
}

export function DiffLines({ patch }: { patch: string }) {
  const lines = patch.split("\n");
  const visible = lines.slice(0, MAX_RENDER_LINES);
  return (
    <div className="ph-no-capture overflow-x-auto font-mono text-[11px] leading-4">
      {visible.map((line, index) => {
        const kind = diffLineKind(line);
        const style = DIFF_LINE_STYLE[kind];
        return (
          <div
            key={index}
            className="flex whitespace-pre"
            style={{ color: style.color, background: style.background }}
            data-diff-kind={kind}
          >
            <span className="w-4 shrink-0 text-center select-none">
              {kind === "add" ? "+" : kind === "del" ? "-" : " "}
            </span>
            <span className="pr-2 break-all whitespace-pre-wrap">{line}</span>
          </div>
        );
      })}
      {lines.length > MAX_RENDER_LINES ? (
        <div className="px-2 py-1" style={{ color: "var(--text-tertiary)" }}>
          {lines.length - MAX_RENDER_LINES} more lines not shown.
        </div>
      ) : null}
    </div>
  );
}

function FileRow({ file }: { file: CommitDiffFile }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b last:border-b-0" style={{ borderColor: "var(--border-subtle)" }}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left"
      >
        <span style={{ color: "var(--text-tertiary)" }}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
        <span className="w-3 shrink-0 text-center font-mono text-[10px] font-bold" style={{ color: statusColor(file.status) }}>
          {file.status}
        </span>
        <span className="truncate font-mono text-[11px]" style={{ color: "var(--text-primary)" }} title={file.path}>
          {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        </span>
        <span className="ml-auto shrink-0 font-mono text-[10px]" style={{ color: "var(--text-tertiary)" }}>
          {file.binary ? (
            "binary"
          ) : file.additions == null && file.deletions == null ? (
            "—"
          ) : (
            <>
              <span style={{ color: "var(--success)" }}>+{file.additions ?? 0}</span>{" "}
              <span style={{ color: "var(--danger)" }}>−{file.deletions ?? 0}</span>
            </>
          )}
        </span>
      </button>
      {open ? (
        <div className="border-t" style={{ borderColor: "var(--border-subtle)" }}>
          {file.patch ? (
            <DiffLines patch={file.patch} />
          ) : (
            <div className="px-3 py-2 text-[11px]" style={{ color: "var(--text-tertiary)" }}>
              {file.binary ? "Binary file — diff not shown." : "Patch omitted for this file (diff too large)."}
            </div>
          )}
          {file.truncated && file.patch ? (
            <div className="px-3 py-1 text-[10px]" style={{ color: "var(--text-tertiary)" }}>
              Patch truncated by the server.
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

interface GitCommitDetailProps {
  commit: CommitSummary;
  diff: CommitDiffState | null;
  diffStatus: CommitGraphStatus;
  diffError: AppErrorCategory | null;
  onClose: () => void;
}

export default function GitCommitDetail({ commit, diff, diffStatus, diffError, onClose }: GitCommitDetailProps) {
  return (
    <div
      className="flex max-h-[45%] shrink-0 flex-col border-t"
      style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
      data-testid="git-commit-detail"
    >
      <div className="flex shrink-0 items-start gap-2 px-2.5 pt-2">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium break-words" style={{ color: "var(--text-primary)" }}>
            {commit.subject}
          </div>
          <div className="mt-0.5 truncate text-[11px]" style={{ color: "var(--text-tertiary)" }}>
            <span className="font-mono">{commit.sha.slice(0, 8)}</span>
            {" · "}
            {commit.author}
            {relativeTime(commit.timestamp) ? ` · ${relativeTime(commit.timestamp)}` : ""}
            {commit.parents.length > 1 ? ` · merge of ${commit.parents.length} parents` : ""}
          </div>
        </div>
        <IconButton label="Close commit detail" onClick={onClose}>
          <X size={12} />
        </IconButton>
      </div>
      <div className="mt-1.5 min-h-0 flex-1 overflow-y-auto border-t" style={{ borderColor: "var(--border-subtle)" }}>
        {diffStatus === "loading" ? (
          <div role="status" className="px-3 py-2 text-[11px]" style={{ color: "var(--text-tertiary)" }}>
            Loading changes…
          </div>
        ) : null}
        {diffStatus === "error" ? (
          <div role="status" className="px-3 py-2 text-[11px]" style={{ color: "var(--danger)" }}>
            {categoryMessage(diffError ?? "server")}
          </div>
        ) : null}
        {diffStatus === "ready" && diff ? (
          <>
            {diff.truncated ? (
              <div role="status" className="px-3 py-1.5 text-[10px]" style={{ color: "var(--warning)" }}>
                Large commit — some files or lines were omitted.
              </div>
            ) : null}
            {diff.files.length === 0 ? (
              <div className="px-3 py-2 text-[11px]" style={{ color: "var(--text-tertiary)" }}>
                No file changes in this commit.
              </div>
            ) : (
              diff.files.map((file) => <FileRow key={`${file.oldPath ?? ""}:${file.path}`} file={file} />)
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}
