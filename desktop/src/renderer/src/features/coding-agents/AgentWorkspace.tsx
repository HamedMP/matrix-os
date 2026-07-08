import { Bot, ChevronRight, ClipboardCheck, FileText, GitBranch, Play, RefreshCw, Server, SquareTerminal } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  defaultAgentThreadComposerDraft,
  type AgentThreadComposerDraft,
  type ReviewSnapshot,
  type ReviewSummary,
  type RuntimeSummary,
} from "@matrix-os/contracts";
import { Button, EmptyState, StatusDot } from "../../design/primitives";
import { useConnection } from "../../stores/connection";
import { useCodingAgentWorkspace } from "../../stores/coding-agent-workspace";
import { useTabs } from "../../stores/tabs";

const STATUS_COLOR: Record<string, string> = {
  available: "var(--success)",
  running: "var(--success)",
  installed: "var(--success)",
  authenticated: "var(--success)",
  degraded: "var(--warning)",
  setup_required: "var(--warning)",
  auth_required: "var(--warning)",
  missing: "var(--warning)",
  offline: "var(--danger)",
  failed: "var(--danger)",
  unavailable: "var(--danger)",
  unknown: "var(--text-tertiary)",
};
const DEFAULT_STATUS_COLOR = "var(--text-tertiary)";
type ReviewDetailStatus = "idle" | "loading" | "ready" | "error";
type ReviewSnapshotFile = ReviewSnapshot["files"]["items"][number];
type ReviewSnapshotHunk = ReviewSnapshotFile["hunks"][number];
type ReviewSnapshotLine = NonNullable<ReviewSnapshotHunk["lines"]>[number];
type ComposerSeed = {
  seedId: number;
  draft: AgentThreadComposerDraft;
};
type SelectedReviewHunk = {
  key: string;
  file: ReviewSnapshotFile;
  hunk: ReviewSnapshotHunk;
  hunkIndex: number;
};

function capabilityEnabled(summary: RuntimeSummary, id: string): boolean {
  return summary.capabilities.some((capability) => capability.id === id && capability.enabled);
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <section className="flex min-h-0 flex-col gap-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          {title}
        </h2>
        {typeof count === "number" ? (
          <span className="text-xs" style={{ color: "var(--text-tertiary)" }}>
            {count}
          </span>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function RuntimeHeader({ summary, onRefresh }: { summary: RuntimeSummary; onRefresh: () => void }) {
  return (
    <div
      className="flex shrink-0 items-center justify-between border-b px-5 py-4"
      style={{ borderColor: "var(--border-subtle)" }}
    >
      <div className="flex min-w-0 items-center gap-3">
        <span
          className="flex h-9 w-9 items-center justify-center rounded-md"
          style={{ background: "var(--accent-muted)", color: "var(--accent)" }}
        >
          <Bot size={19} />
        </span>
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold" style={{ color: "var(--text-primary)" }}>
            Agent workspace
          </h1>
          <div className="flex items-center gap-2 text-sm" style={{ color: "var(--text-secondary)" }}>
            <StatusDot color={STATUS_COLOR[summary.runtime.status] ?? DEFAULT_STATUS_COLOR} pulse={summary.runtime.status === "available"} />
            <span className="truncate">{summary.runtime.label}</span>
          </div>
        </div>
      </div>
      <Button variant="ghost" onClick={onRefresh} aria-label="Refresh agent workspace">
        <RefreshCw size={14} />
        Refresh
      </Button>
    </div>
  );
}

function ProviderList({ summary }: { summary: RuntimeSummary }) {
  return (
    <Section title="Providers" count={summary.providers.length}>
      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
        {summary.providers.map((provider) => (
          <article
            key={provider.id}
            className="rounded-md border p-3"
            style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="truncate text-sm font-medium" style={{ color: "var(--text-primary)" }}>
                  {provider.displayName}
                </h3>
                <p className="text-xs capitalize" style={{ color: "var(--text-tertiary)" }}>
                  {provider.kind}
                </p>
              </div>
              <StatusDot color={STATUS_COLOR[provider.availability] ?? DEFAULT_STATUS_COLOR} />
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
              <div>
                <dt style={{ color: "var(--text-tertiary)" }}>Install</dt>
                <dd style={{ color: "var(--text-secondary)" }}>{provider.installStatus.replace(/_/g, " ")}</dd>
              </div>
              <div>
                <dt style={{ color: "var(--text-tertiary)" }}>Auth</dt>
                <dd style={{ color: "var(--text-secondary)" }}>{provider.authStatus.replace(/_/g, " ")}</dd>
              </div>
            </dl>
          </article>
        ))}
        {summary.providers.length === 0 ? (
          <p className="rounded-md border p-3 text-sm" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>
            No providers are ready.
          </p>
        ) : null}
      </div>
    </Section>
  );
}

export function mergeAttachments(
  current: AgentThreadComposerDraft["attachments"],
  seeded: AgentThreadComposerDraft["attachments"],
): AgentThreadComposerDraft["attachments"] {
  const currentAttachments = current ?? [];
  const seededById = new Map((seeded ?? []).map((attachment) => [attachment.id, attachment]));
  const merged = currentAttachments.map((attachment) => seededById.get(attachment.id) ?? attachment);
  const seen = new Set(merged.map((attachment) => attachment.id));
  for (const attachment of seeded ?? []) {
    if (seen.has(attachment.id) || merged.length >= 8) continue;
    seen.add(attachment.id);
    merged.push(attachment);
  }
  return merged.length ? merged : undefined;
}

export function mergeComposerSeed(current: AgentThreadComposerDraft, seeded: AgentThreadComposerDraft): AgentThreadComposerDraft {
  const currentPrompt = current.prompt.trim();
  const seededPrompt = seeded.prompt.trim();
  const attachments = mergeAttachments(current.attachments, seeded.attachments);
  const missingRequiredReference = (seeded.attachments ?? [])
    .some((attachment) => attachment.kind === "structured_ref"
      && !attachments?.some((candidate) => candidate.id === attachment.id));
  if (missingRequiredReference) return current;

  return {
    ...seeded,
    providerId: current.providerId ?? seeded.providerId,
    mode: current.mode ?? seeded.mode,
    approvalPolicy: current.approvalPolicy ?? seeded.approvalPolicy,
    sandboxMode: current.sandboxMode ?? seeded.sandboxMode,
    prompt: currentPrompt && currentPrompt !== seededPrompt
      ? `${current.prompt.trimEnd()}\n\n---\n\n${seeded.prompt}`
      : seeded.prompt,
    attachments,
  };
}

export function clearComposerLaunchContext(current: AgentThreadComposerDraft): AgentThreadComposerDraft {
  const attachments = current.attachments?.filter((attachment) => attachment.kind !== "structured_ref");
  return {
    ...current,
    projectId: undefined,
    taskId: undefined,
    terminalSessionId: undefined,
    worktreeId: undefined,
    attachments: attachments?.length ? attachments : undefined,
  };
}

function hasComposerContent(current: AgentThreadComposerDraft): boolean {
  return current.prompt.trim().length > 0
    || Boolean(current.projectId)
    || Boolean(current.taskId)
    || Boolean(current.terminalSessionId)
    || Boolean(current.worktreeId)
    || Boolean(current.attachments?.length);
}

function AgentComposer({ summary, seed }: { summary: RuntimeSummary; seed: ComposerSeed | null }) {
  const initialDraft = useMemo(() => defaultAgentThreadComposerDraft(summary), [summary]);
  const [draft, setDraft] = useState<AgentThreadComposerDraft>(initialDraft);
  const createStatus = useCodingAgentWorkspace((s) => s.createStatus);
  const createError = useCodingAgentWorkspace((s) => s.createError);
  const createThread = useCodingAgentWorkspace((s) => s.createThread);
  const openTab = useTabs((s) => s.openTab);
  const canCreate = capabilityEnabled(summary, "codingAgentsThreadCreate");

  useEffect(() => {
    setDraft((current) => hasComposerContent(current) ? current : initialDraft);
  }, [initialDraft]);

  useEffect(() => {
    if (!seed) return;
    setDraft((current) => mergeComposerSeed(current, seed.draft));
  }, [seed]);

  if (!canCreate) return null;

  const selectedProvider = summary.providers.find((provider) => provider.id === draft.providerId);
  const modes = selectedProvider?.supportedModes ?? [];

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submittedDraft = draft;
    const threadId = await createThread(submittedDraft);
    if (!threadId) {
      setDraft((current) => clearComposerLaunchContext(current));
      return;
    }
    const thread = useCodingAgentWorkspace
      .getState()
      .summary?.activeThreads.items.find((candidate) => candidate.id === threadId);
    openTab({
      kind: "thread",
      threadId,
      title: thread?.title ?? "Agent thread",
      closable: true,
    });
    setDraft(initialDraft);
  }

  return (
    <Section title="New Run">
      <form
        onSubmit={(event) => void submit(event)}
        className="grid gap-3 rounded-md border p-3"
        style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
      >
        <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_180px]">
          <label className="grid gap-1 text-xs" style={{ color: "var(--text-tertiary)" }}>
            Provider
            <select
              className="h-8 rounded-md border px-2 text-sm outline-none"
              style={{
                borderColor: "var(--border-subtle)",
                background: "var(--bg-overlay)",
                color: "var(--text-primary)",
              }}
              value={draft.providerId ?? ""}
              onChange={(event) => {
                const provider = summary.providers.find((candidate) => candidate.id === event.target.value);
                setDraft((current) => ({
                  ...current,
                  providerId: provider?.id,
                  mode: provider?.defaultMode ?? current.mode,
                }));
              }}
            >
              {summary.providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.displayName}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-xs" style={{ color: "var(--text-tertiary)" }}>
            Mode
            <select
              className="h-8 rounded-md border px-2 text-sm outline-none"
              style={{
                borderColor: "var(--border-subtle)",
                background: "var(--bg-overlay)",
                color: "var(--text-primary)",
              }}
              value={draft.mode ?? ""}
              onChange={(event) => {
                const mode = modes.find((candidate) => candidate === event.target.value);
                if (!mode) return;
                setDraft((current) => ({ ...current, mode }));
              }}
            >
              {modes.map((mode) => (
                <option key={mode} value={mode}>
                  {mode.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="grid gap-1 text-xs" style={{ color: "var(--text-tertiary)" }}>
          <span className="sr-only">Agent run prompt</span>
          <textarea
            aria-label="Agent run prompt"
            className="min-h-[92px] resize-y rounded-md border px-3 py-2 text-sm outline-none"
            style={{
              borderColor: "var(--border-subtle)",
              background: "var(--bg-overlay)",
              color: "var(--text-primary)",
            }}
            value={draft.prompt}
            onChange={(event) => setDraft((current) => ({ ...current, prompt: event.target.value }))}
          />
        </label>
        <div className="flex items-center justify-between gap-3">
          <p className="min-h-5 text-sm" style={{ color: createError ? "var(--danger)" : "var(--text-tertiary)" }}>
            {createError ?? ""}
          </p>
          <Button variant="primary" type="submit" disabled={createStatus === "submitting"}>
            <Play size={14} />
            {createStatus === "submitting" ? "Starting" : "Start run"}
          </Button>
        </div>
      </form>
    </Section>
  );
}

function ThreadList({ summary }: { summary: RuntimeSummary }) {
  return (
    <Section title="Active Threads" count={summary.activeThreads.items.length}>
      <div className="grid gap-2">
        {summary.activeThreads.items.map((thread) => (
          <article
            key={thread.id}
            className="flex items-center justify-between gap-3 rounded-md border p-3"
            style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
          >
            <div className="flex min-w-0 items-center gap-2">
              <GitBranch size={15} style={{ color: "var(--text-tertiary)" }} />
              <div className="min-w-0">
                <h3 className="truncate text-sm font-medium" style={{ color: "var(--text-primary)" }}>
                  {thread.title}
                </h3>
                <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>
                  {thread.providerId}
                </p>
              </div>
            </div>
            <span className="shrink-0 text-xs capitalize" style={{ color: "var(--text-secondary)" }}>
              {thread.status.replace(/_/g, " ")}
            </span>
          </article>
        ))}
        {summary.activeThreads.items.length === 0 ? (
          <p className="rounded-md border p-3 text-sm" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>
            No active threads.
          </p>
        ) : null}
      </div>
    </Section>
  );
}

function TerminalList({ summary }: { summary: RuntimeSummary }) {
  return (
    <Section title="Terminals" count={summary.terminalSessions.items.length}>
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
    </Section>
  );
}

function reviewStatusLabel(status: ReviewSummary["status"]): string {
  return status.replace(/_/g, " ");
}

function formatHunkRange(hunk: ReviewSnapshot["files"]["items"][number]["hunks"][number]): string {
  return `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
}

function reviewDiffLineMarker(line: ReviewSnapshotLine): string {
  if (line.kind === "add") return "+";
  if (line.kind === "remove") return "-";
  return " ";
}

function reviewDiffLineColor(line: ReviewSnapshotLine): string {
  if (line.kind === "add") return "var(--success)";
  if (line.kind === "remove") return "var(--danger)";
  return "var(--text-secondary)";
}

function reviewDiffOldLine(line: ReviewSnapshotLine): number | null {
  return "oldLine" in line ? line.oldLine : null;
}

function reviewDiffNewLine(line: ReviewSnapshotLine): number | null {
  return "newLine" in line ? line.newLine : null;
}

function reviewDiffLineLabel(line: ReviewSnapshotLine): string {
  const parts = [
    line.kind === "add" ? "Added line" : line.kind === "remove" ? "Removed line" : "Context line",
  ];
  const oldLine = reviewDiffOldLine(line);
  const newLine = reviewDiffNewLine(line);
  if (oldLine !== null) parts.push("old", String(oldLine));
  if (newLine !== null) parts.push("new", String(newLine));
  return parts.join(" ");
}

function ReviewDiffLines({ lines }: { lines: ReviewSnapshotLine[] }) {
  if (!lines.length) return null;

  return (
    <div
      className="ph-no-capture mx-3 mb-2 overflow-hidden rounded border font-mono text-xs"
      style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
    >
      {lines.map((line, index) => (
        <div
          key={`${line.kind}:${reviewDiffOldLine(line) ?? ""}:${reviewDiffNewLine(line) ?? ""}:${index}`}
          aria-label={reviewDiffLineLabel(line)}
          className="grid min-h-6 grid-cols-[24px_44px_44px_minmax(0,1fr)] items-start gap-2 border-b px-2 py-1 last:border-b-0"
          style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}
        >
          <span style={{ color: reviewDiffLineColor(line) }}>{reviewDiffLineMarker(line)}</span>
          <span className="text-right tabular-nums" style={{ color: "var(--text-tertiary)" }}>
            {reviewDiffOldLine(line) ?? ""}
          </span>
          <span className="text-right tabular-nums" style={{ color: "var(--text-tertiary)" }}>
            {reviewDiffNewLine(line) ?? ""}
          </span>
          <code className="min-w-0 whitespace-pre-wrap break-words" style={{ color: "var(--text-primary)" }}>
            {line.content}
          </code>
        </div>
      ))}
    </div>
  );
}

function ReviewList({
  canCreateFollowUp,
  onAskHunkFollowUp,
}: {
  canCreateFollowUp: boolean;
  onAskHunkFollowUp: (snapshot: ReviewSnapshot, selected: SelectedReviewHunk) => void;
}) {
  const reviewsStatus = useCodingAgentWorkspace((s) => s.reviewsStatus);
  const reviews = useCodingAgentWorkspace((s) => s.reviews);
  const reviewsError = useCodingAgentWorkspace((s) => s.reviewsError);
  const selectedReviewId = useCodingAgentWorkspace((s) => s.selectedReviewId);
  const reviewSnapshotStatus = useCodingAgentWorkspace((s) => s.reviewSnapshotStatus);
  const reviewSnapshot = useCodingAgentWorkspace((s) => s.reviewSnapshot);
  const reviewSnapshotError = useCodingAgentWorkspace((s) => s.reviewSnapshotError);
  const selectReview = useCodingAgentWorkspace((s) => s.selectReview);
  const items = reviews?.items ?? [];

  return (
    <Section title="Review" count={items.length}>
      <div className="grid gap-3">
        {reviewsStatus === "error" ? (
          <p className="rounded-md border p-3 text-sm" style={{ borderColor: "var(--border-subtle)", color: "var(--danger)" }}>
            {reviewsError ?? "Review state unavailable"}
          </p>
        ) : null}
        {items.map((review) => (
          <button
            key={review.id}
            type="button"
            aria-label={`Open review PR #${review.pullRequestNumber}`}
            className="no-drag flex min-h-[68px] w-full items-center justify-between gap-3 rounded-md border p-3 text-left transition-colors duration-100 hover:brightness-105"
            onClick={() => void selectReview(review.id)}
            style={{
              borderColor: selectedReviewId === review.id ? "var(--accent)" : "var(--border-subtle)",
              background: "var(--bg-surface)",
            }}
          >
            <div className="flex min-w-0 items-center gap-2">
              <ClipboardCheck size={15} style={{ color: "var(--text-tertiary)" }} />
              <div className="min-w-0">
                <h3 className="truncate text-sm font-medium" style={{ color: "var(--text-primary)" }}>
                  {review.projectId}
                </h3>
                <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>
                  {`PR #${review.pullRequestNumber} - Round ${review.round} of ${review.maxRounds}`}
                </p>
              </div>
            </div>
            <div className="shrink-0 text-right text-xs" style={{ color: "var(--text-secondary)" }}>
              <p className="capitalize">{reviewStatusLabel(review.status)}</p>
              {review.findings ? (
                <p style={{ color: review.findings.high > 0 ? "var(--danger)" : "var(--text-tertiary)" }}>
                  {review.findings.high} high
                </p>
              ) : null}
            </div>
            <ChevronRight size={15} style={{ color: "var(--text-tertiary)" }} />
          </button>
        ))}
        <ReviewSnapshotPanel
          status={reviewSnapshotStatus}
          snapshot={reviewSnapshot}
          error={reviewSnapshotError}
          canCreateFollowUp={canCreateFollowUp}
          onAskHunkFollowUp={onAskHunkFollowUp}
        />
        {reviewsStatus !== "error" && reviewsStatus !== "loading" && items.length === 0 ? (
          <p className="rounded-md border p-3 text-sm" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>
            No reviews.
          </p>
        ) : null}
      </div>
    </Section>
  );
}

function ReviewSnapshotPanel({
  status,
  snapshot,
  error,
  canCreateFollowUp,
  onAskHunkFollowUp,
}: {
  status: ReviewDetailStatus;
  snapshot: ReviewSnapshot | null;
  error: string | null;
  canCreateFollowUp: boolean;
  onAskHunkFollowUp: (snapshot: ReviewSnapshot, selected: SelectedReviewHunk) => void;
}) {
  const [selectedHunkKey, setSelectedHunkKey] = useState<string | null>(null);
  const selectedHunk = useMemo(() => {
    if (!snapshot || !selectedHunkKey) return null;
    for (const [fileIndex, file] of snapshot.files.items.entries()) {
      for (const [hunkIndex, hunk] of file.hunks.entries()) {
        const key = reviewHunkKey(fileIndex, file, hunk, hunkIndex);
        if (key === selectedHunkKey) return { key, file, hunk, hunkIndex };
      }
    }
    return null;
  }, [selectedHunkKey, snapshot]);

  useEffect(() => {
    setSelectedHunkKey(null);
  }, [snapshot?.review.id, snapshot?.updatedAt]);

  if (status === "idle") return null;
  if (status === "loading") {
    return (
      <p className="rounded-md border p-3 text-sm" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>
        Loading review details...
      </p>
    );
  }
  if (status === "error") {
    return (
      <p className="rounded-md border p-3 text-sm" style={{ borderColor: "var(--border-subtle)", color: "var(--danger)" }}>
        {error ?? "Review details unavailable"}
      </p>
    );
  }
  if (!snapshot) return null;

  return (
    <article className="grid gap-3 rounded-md border p-3" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-medium" style={{ color: "var(--text-primary)" }}>
            {`PR #${snapshot.review.pullRequestNumber} review details`}
          </h3>
          <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>
            {`${snapshot.files.items.length} files${snapshot.partial ? " - partial" : ""}`}
          </p>
        </div>
        <span className="shrink-0 text-xs capitalize" style={{ color: "var(--text-secondary)" }}>
          {reviewStatusLabel(snapshot.review.status)}
        </span>
      </div>
      {snapshot.safeNotice ? (
        <p className="rounded-md border px-3 py-2 text-xs" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>
          {snapshot.safeNotice}
        </p>
      ) : null}
      <div className="grid gap-2">
        {snapshot.files.items.map((file, fileIndex) => (
          <div
            key={`${file.path}:${fileIndex}`}
            className="grid gap-2 rounded-md border px-3 py-2"
            style={{ borderColor: "var(--border-subtle)", background: "var(--bg-overlay)" }}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <FileText size={14} style={{ color: "var(--text-tertiary)" }} />
                <span className="truncate text-sm" style={{ color: "var(--text-primary)" }}>
                  {file.path}
                </span>
              </div>
              <span className="shrink-0 text-xs capitalize" style={{ color: "var(--text-tertiary)" }}>
                {file.status}
              </span>
            </div>
            {file.findings?.length ? (
              <div className="grid gap-1">
                {file.findings.map((finding) => (
                  <p key={finding.id} className="text-xs" style={{ color: finding.severity === "high" ? "var(--danger)" : "var(--text-secondary)" }}>
                    {finding.summary}
                  </p>
                ))}
              </div>
            ) : (
              <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>
                No findings in this file.
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded border px-2 py-1" style={{ borderColor: "var(--border-subtle)", color: "var(--success)" }}>
                +{file.additions}
              </span>
              <span className="rounded border px-2 py-1" style={{ borderColor: "var(--border-subtle)", color: "var(--danger)" }}>
                -{file.deletions}
              </span>
              {file.partial ? (
                <span className="rounded border px-2 py-1" style={{ borderColor: "var(--border-subtle)", color: "var(--text-tertiary)" }}>
                  Partial file
                </span>
              ) : null}
            </div>
            {file.hunks.length ? (
              <div className="grid gap-1">
                {file.hunks.map((hunk, hunkIndex) => {
                  const hunkKey = reviewHunkKey(fileIndex, file, hunk, hunkIndex);
                  const selected = selectedHunk?.key === hunkKey;
                  return (
                    <div
                      key={`${file.path}:${fileIndex}:${hunk.id}:${hunkIndex}`}
                      className="grid gap-1 rounded-md border transition-colors duration-100"
                      style={{
                        borderColor: selected ? "var(--accent)" : "var(--border-subtle)",
                        background: selected ? "var(--accent-muted)" : "transparent",
                      }}
                    >
                      <button
                        type="button"
                        aria-label={`Select hunk ${hunkIndex + 1} in ${file.path}`}
                        aria-pressed={selected}
                        className="no-drag grid gap-1 rounded-md px-3 py-2 text-left transition-colors duration-100 hover:brightness-105"
                        onClick={() => setSelectedHunkKey(hunkKey)}
                        style={{ background: "transparent" }}
                      >
                        <span className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
                          {`Hunk ${hunkIndex + 1}`}
                        </span>
                        <span className="font-mono text-xs" style={{ color: "var(--text-primary)" }}>
                          {formatHunkRange(hunk)}
                        </span>
                        {hunk.partial ? (
                          <span className="text-xs" style={{ color: "var(--text-tertiary)" }}>
                            Partial hunk
                          </span>
                        ) : null}
                      </button>
                      <ReviewDiffLines lines={hunk.lines ?? []} />
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
        ))}
      </div>
      {selectedHunk ? (
        <div className="flex justify-end">
          <Button
            variant="ghost"
            type="button"
            disabled={!canCreateFollowUp}
            onClick={() => onAskHunkFollowUp(snapshot, selectedHunk)}
            aria-label="Ask agent about selected hunk"
          >
            <Bot size={14} />
            Ask agent about selected hunk
          </Button>
        </div>
      ) : null}
    </article>
  );
}

function reviewHunkKey(fileIndex: number, file: ReviewSnapshotFile, hunk: ReviewSnapshotHunk, hunkIndex: number): string {
  return `${fileIndex}\u0000${file.path}\u0000${hunk.id}\u0000${hunkIndex}`;
}

function safeReferenceSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]+/g, "_").replace(/\.\.+/g, "_").slice(0, 64) || "ref";
}

function reviewHunkFollowUpDraft(summary: RuntimeSummary, snapshot: ReviewSnapshot, selected: SelectedReviewHunk): AgentThreadComposerDraft {
  const base = defaultAgentThreadComposerDraft(summary);
  const range = formatHunkRange(selected.hunk);
  const hunkNumber = selected.hunkIndex + 1;
  return {
    ...base,
    projectId: snapshot.review.projectId,
    prompt: [
      "Please follow up on this review hunk.",
      "",
      `Review: PR #${snapshot.review.pullRequestNumber}, round ${snapshot.review.round} of ${snapshot.review.maxRounds}`,
      `Project: ${snapshot.review.projectId}`,
      `File: ${selected.file.path}`,
      `Hunk: ${range}`,
      "",
      "Use the structured reference attached to inspect the current source and propose the smallest safe fix.",
    ].join("\n"),
    attachments: [
      {
        id: `review:${safeReferenceSegment(snapshot.review.id)}:hunk:${safeReferenceSegment(selected.hunk.id)}`,
        kind: "structured_ref",
        label: `Review hunk ${hunkNumber}`,
        path: selected.file.path,
      },
    ],
  };
}

export default function AgentWorkspace() {
  const runtimeSlot = useConnection((s) => s.runtimeSlot);
  const status = useCodingAgentWorkspace((s) => s.status);
  const summary = useCodingAgentWorkspace((s) => s.summary);
  const error = useCodingAgentWorkspace((s) => s.error);
  const refresh = useCodingAgentWorkspace((s) => s.refresh);
  const [composerSeed, setComposerSeed] = useState<ComposerSeed | null>(null);

  useEffect(() => {
    void refresh();
  }, [refresh, runtimeSlot]);

  if (status === "loading" && !summary) {
    return (
      <EmptyState
        icon={<Server size={28} />}
        headline="Loading workspace..."
        description="Fetching runtime state from your Matrix computer."
      />
    );
  }

  if (status === "error" && !summary) {
    return (
      <EmptyState
        icon={<Server size={28} />}
        headline={error ?? "Runtime summary unavailable"}
        description="Refresh the workspace or check your selected runtime."
        action={<Button onClick={() => void refresh()}>Retry</Button>}
      />
    );
  }

  if (!summary) return null;

  const canCreateFollowUp = capabilityEnabled(summary, "codingAgentsThreadCreate");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <RuntimeHeader summary={summary} onRefresh={() => void refresh()} />
      <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto p-5">
        <AgentComposer summary={summary} seed={composerSeed} />
        <ProviderList summary={summary} />
        <div className="grid gap-4 xl:grid-cols-2">
          <ThreadList summary={summary} />
          <TerminalList summary={summary} />
        </div>
        {capabilityEnabled(summary, "codingAgentsReview") ? (
          <ReviewList
            canCreateFollowUp={canCreateFollowUp}
            onAskHunkFollowUp={(snapshot, selected) => {
              setComposerSeed({
                seedId: Date.now(),
                draft: reviewHunkFollowUpDraft(summary, snapshot, selected),
              });
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
