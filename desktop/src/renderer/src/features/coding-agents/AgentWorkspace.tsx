import { Bell, Bot, ChevronRight, ClipboardCheck, ExternalLink, FileText, FolderOpen, GitBranch, GitCommitHorizontal, GitPullRequest, Play, Save, Search, Server, SquareTerminal } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  defaultAgentThreadComposerDraft,
  type AgentThreadComposerDraft,
  type FileBrowseResponse,
  type FileReadRequest,
  type FileReadResponse,
  type FileSearchResponse,
  type ReviewSnapshot,
  type ReviewSummary,
  type RuntimeSummary,
  type SourceControlCreatePullRequestRequest,
  type SourceControlCreatePullRequestResponse,
  type SourceControlPrepareCommitRequest,
} from "@matrix-os/contracts";
import { codingAgentRuntimeScope } from "../../../../shared/coding-agent-project-workspace";
import { Button, EmptyState, StatusDot } from "../../design/primitives";
import { invoke } from "../../lib/operator";
import { useConnection } from "../../stores/connection";
import {
  clearCodingAgentRuntimeSelection,
  useCodingAgentWorkspace,
} from "../../stores/coding-agent-workspace";
import { useCodingAgentProjectWorkspace } from "../../stores/coding-agent-project-workspace";
import { useTabs } from "../../stores/tabs";
import { AgentPreviewList, AgentTerminalList } from "./AgentWorkspaceContext";
import { AgentRuntimeHeader } from "./AgentRuntimeHeader";
import { AgentProjectWorkspaceShell } from "./AgentProjectWorkspaceShell";
import { AgentConversationView } from "./AgentConversationView";
import { AgentWorkspaceViewSwitch } from "./AgentKanbanBoard";
import { AgentKanbanWorkspace } from "./AgentKanbanWorkspace";
import { AgentConversationInspector } from "./AgentConversationInspector";
import { AgentWorkspaceSection as Section } from "./AgentWorkspaceSection";
import { toast } from "sonner";

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
type FileBrowserStatus = "idle" | "loading" | "ready" | "error";
type FileReadStatus = "idle" | "loading" | "ready" | "error";
type FileWriteStatus = "idle" | "saving" | "saved" | "error";
type ComposerSeed = {
  seedId: number;
  draft: AgentThreadComposerDraft;
};
type NotificationPreferenceKey = "approval" | "input" | "failed" | "completed";
type SelectedReviewHunk = {
  key: string;
  file: ReviewSnapshotFile;
  hunk: ReviewSnapshotHunk;
  hunkIndex: number;
};

function capabilityEnabled(summary: RuntimeSummary, id: string): boolean {
  return summary.capabilities.some((capability) => capability.id === id && capability.enabled);
}

function InspectorEmptyState({ message }: { message: string }) {
  return (
    <p
      className="rounded-md border p-3 text-sm"
      style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)", background: "var(--bg-surface)" }}
    >
      {message}
    </p>
  );
}

const NOTIFICATION_TOGGLES: Array<{ key: NotificationPreferenceKey; label: string; detail: string }> = [
  { key: "approval", label: "Approval alerts", detail: "Approval-required runs" },
  { key: "input", label: "Input request alerts", detail: "Runs waiting for a response" },
  { key: "failed", label: "Failed run alerts", detail: "Runs that need recovery" },
  { key: "completed", label: "Completion alerts", detail: "Runs that finish successfully" },
];

function NotificationPreferencesPanel() {
  const status = useCodingAgentWorkspace((s) => s.notificationPreferencesStatus);
  const preferences = useCodingAgentWorkspace((s) => s.notificationPreferences);
  const error = useCodingAgentWorkspace((s) => s.notificationPreferencesError);
  const updateNotificationPreferences = useCodingAgentWorkspace((s) => s.updateNotificationPreferences);
  const disabled = status === "loading" || status === "saving" || !preferences;

  return (
    <Section title="Notifications">
      <div
        className="grid gap-2 rounded-md border p-3"
        style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
      >
        {NOTIFICATION_TOGGLES.map((item) => (
          <label
            key={item.key}
            className="flex min-w-0 items-center justify-between gap-3 rounded-md border px-3 py-2"
            style={{ borderColor: "var(--border-subtle)", color: "var(--text-primary)" }}
          >
            <span className="flex min-w-0 items-center gap-2">
              <Bell size={14} aria-hidden="true" />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{item.label}</span>
                <span className="block truncate text-xs" style={{ color: "var(--text-tertiary)" }}>
                  {item.detail}
                </span>
              </span>
            </span>
            <input
              aria-label={item.label}
              type="checkbox"
              className="h-4 w-4 shrink-0"
              checked={Boolean(preferences?.attentionPush[item.key])}
              disabled={disabled}
              onChange={(event) => {
                if (!preferences) return;
                void updateNotificationPreferences({
                  attentionPush: { [item.key]: event.currentTarget.checked },
                });
              }}
            />
          </label>
        ))}
        {error ? (
          <p className="text-xs" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        ) : null}
      </div>
    </Section>
  );
}

function ProviderList({ summary }: { summary: RuntimeSummary }) {
  return (
    <Section title="Providers" count={summary.providers.length}>
      <div className="grid gap-2">
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

type RuntimeAttentionThread = RuntimeSummary["attentionThreads"]["items"][number];

function threadAttentionLabel(attention: RuntimeAttentionThread["attention"]): string | null {
  switch (attention) {
    case "approval_required":
      return "Approval needed";
    case "input_required":
      return "Input needed";
    case "failed":
      return "Failed";
    case "completed":
      return "Completed";
    default:
      return null;
  }
}

function AttentionThreadList({ summary }: { summary: RuntimeSummary }) {
  const activeThreadId = useCodingAgentWorkspace((s) => s.activeThreadId);
  const loadThreadSnapshot = useCodingAgentWorkspace((s) => s.loadThreadSnapshot);

  return (
    <Section title="Needs Attention" count={summary.attentionThreads.items.length}>
      <div className="grid gap-2">
        {summary.attentionThreads.items.map((thread) => {
          const active = activeThreadId === thread.id;
          const attentionLabel = threadAttentionLabel(thread.attention) ?? thread.status.replace(/_/g, " ");

          return (
            <button
              key={thread.id}
              type="button"
              aria-current={active ? "true" : undefined}
              aria-label={`Open details for ${thread.title}, ${attentionLabel}`}
              className="no-drag flex min-h-[68px] w-full items-center justify-between gap-3 rounded-md border p-3 text-left transition-colors duration-100 hover:brightness-105"
              style={{
                borderColor: active ? "var(--accent)" : "var(--border-subtle)",
                background: active ? "var(--accent-muted)" : "var(--bg-surface)",
              }}
              onClick={() => void loadThreadSnapshot(thread.id)}
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
              <div className="flex shrink-0 items-center gap-2">
                <span className="rounded-md border px-2 py-1 text-xs" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>
                  {attentionLabel}
                </span>
                <ChevronRight size={14} style={{ color: "var(--text-tertiary)" }} />
              </div>
            </button>
          );
        })}
        {summary.attentionThreads.items.length === 0 ? (
          <p className="rounded-md border p-3 text-sm" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>
            No attention needed.
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
    prompt: !seededPrompt
      ? current.prompt
      : currentPrompt && currentPrompt !== seededPrompt
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

function AgentComposer({ summary, seed, focusRequestId, onCreated }: { summary: RuntimeSummary; seed: ComposerSeed | null; focusRequestId: number; onCreated?: () => void }) {
  const initialDraft = useMemo(() => defaultAgentThreadComposerDraft(summary), [summary]);
  const [draft, setDraft] = useState<AgentThreadComposerDraft>(initialDraft);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const createStatus = useCodingAgentWorkspace((s) => s.createStatus);
  const createError = useCodingAgentWorkspace((s) => s.createError);
  const createThread = useCodingAgentWorkspace((s) => s.createThread);
  const canCreate = capabilityEnabled(summary, "codingAgentsThreadCreate");

  useEffect(() => {
    setDraft((current) => hasComposerContent(current) ? current : initialDraft);
  }, [initialDraft]);

  useEffect(() => {
    if (!seed) return;
    setDraft((current) => mergeComposerSeed(current, seed.draft));
  }, [seed]);

  useEffect(() => {
    if (focusRequestId <= 0) return;
    promptRef.current?.focus();
  }, [focusRequestId]);

  if (!canCreate) {
    return (
      <Section title="New Run">
        <div
          className="rounded-md border p-3 text-sm"
          style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)", color: "var(--text-secondary)" }}
        >
          Agent runs are not available on this runtime yet.
        </div>
      </Section>
    );
  }

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
    setDraft(initialDraft);
    onCreated?.();
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
            ref={promptRef}
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
  const openTab = useTabs((s) => s.openTab);
  const activeThreadId = useCodingAgentWorkspace((s) => s.activeThreadId);
  const loadThreadSnapshot = useCodingAgentWorkspace((s) => s.loadThreadSnapshot);
  const findAttachableSessionName = (sessionId: string): string | null =>
    summary.terminalSessions.items.find((session) => session.id === sessionId && session.attachable)?.name ?? null;

  return (
    <Section title="Active Threads" count={summary.activeThreads.items.length}>
      <div className="grid gap-2">
        {summary.activeThreads.items.map((thread) => {
          const terminalSessionName = thread.terminalSessionId
            ? findAttachableSessionName(thread.terminalSessionId)
            : null;
          const active = activeThreadId === thread.id;

          return (
            <article
              key={thread.id}
              aria-current={active ? "true" : undefined}
              aria-label={active ? `Active thread ${thread.title}` : `Thread ${thread.title}`}
              className="flex items-center justify-between gap-3 rounded-md border p-3"
              style={{
                borderColor: active ? "var(--accent)" : "var(--border-subtle)",
                background: active ? "var(--accent-muted)" : "var(--bg-surface)",
              }}
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
              <div className="flex shrink-0 items-center gap-2">
                {terminalSessionName ? (
                  <Button
                    variant="ghost"
                    aria-label={`Open terminal for ${thread.title}`}
                    title={`Open terminal for ${thread.title}`}
                    onClick={() => openTab({ kind: "terminal", sessionName: thread.terminalSessionId, title: terminalSessionName })}
                  >
                    <SquareTerminal size={14} />
                  </Button>
                ) : null}
                <span className="text-xs capitalize" style={{ color: "var(--text-secondary)" }}>
                  {thread.status.replace(/_/g, " ")}
                </span>
                <Button
                  variant="ghost"
                  aria-label={`Open details for ${thread.title}`}
                  title={`Open details for ${thread.title}`}
                  onClick={() => void loadThreadSnapshot(thread.id)}
                >
                  <ChevronRight size={14} />
                </Button>
              </div>
            </article>
          );
        })}
        {summary.activeThreads.items.length === 0 ? (
          <p className="rounded-md border p-3 text-sm" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>
            No active threads.
          </p>
        ) : null}
      </div>
    </Section>
  );
}

function CreatedThreadHandleList({ summary }: { summary: RuntimeSummary }) {
  const createdThreadHandles = useCodingAgentWorkspace((s) => s.createdThreadHandles);
  const activeThreadId = useCodingAgentWorkspace((s) => s.activeThreadId);
  const loadThreadSnapshot = useCodingAgentWorkspace((s) => s.loadThreadSnapshot);
  const summaryThreadIds = new Set([
    ...summary.activeThreads.items.map((thread) => thread.id),
    ...summary.attentionThreads.items.map((thread) => thread.id),
  ]);
  const visibleHandles = createdThreadHandles.filter((thread) => !summaryThreadIds.has(thread.id));

  if (visibleHandles.length === 0) return null;

  return (
    <Section title="Created Runs" count={visibleHandles.length}>
      <div className="grid gap-2">
        {visibleHandles.map((thread) => {
          const active = activeThreadId === thread.id;
          return (
            <button
              key={thread.id}
              type="button"
              aria-current={active ? "true" : undefined}
              aria-label={`Open created run ${thread.title}`}
              className="no-drag flex min-h-[64px] items-center justify-between gap-3 rounded-md border p-3 text-left transition-colors duration-100 hover:brightness-105"
              style={{
                borderColor: active ? "var(--accent)" : "var(--border-subtle)",
                background: active ? "var(--accent-muted)" : "var(--bg-surface)",
              }}
              onClick={() => void loadThreadSnapshot(thread.id)}
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
            </button>
          );
        })}
      </div>
    </Section>
  );
}


function canOpenPreviewExternally(origin: string | undefined): origin is string {
  if (!origin) return false;
  try {
    return new URL(origin).protocol === "https:";
  } catch {
    return false;
  }
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
      className="ph-no-capture mx-3 mb-2 min-w-0 overflow-x-auto rounded border font-mono text-xs"
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
  canReadFiles,
  canPrepareCommit,
  canCreateFollowUp,
  onAskHunkFollowUp,
}: {
  canReadFiles: boolean;
  canPrepareCommit: boolean;
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
  const fileReadStatus = useCodingAgentWorkspace((s) => s.fileReadStatus);
  const fileRead = useCodingAgentWorkspace((s) => s.fileRead);
  const fileReadError = useCodingAgentWorkspace((s) => s.fileReadError);
  const fileWriteStatus = useCodingAgentWorkspace((s) => s.fileWriteStatus);
  const fileWriteError = useCodingAgentWorkspace((s) => s.fileWriteError);
  const sourceCommitStatus = useCodingAgentWorkspace((s) => s.sourceCommitStatus);
  const sourceCommitError = useCodingAgentWorkspace((s) => s.sourceCommitError);
  const sourcePullRequestStatus = useCodingAgentWorkspace((s) => s.sourcePullRequestStatus);
  const sourcePullRequest = useCodingAgentWorkspace((s) => s.sourcePullRequest);
  const sourcePullRequestError = useCodingAgentWorkspace((s) => s.sourcePullRequestError);
  const selectedFilePath = useCodingAgentWorkspace((s) => s.selectedFilePath);
  const selectReview = useCodingAgentWorkspace((s) => s.selectReview);
  const loadFileContent = useCodingAgentWorkspace((s) => s.loadFileContent);
  const saveFileContent = useCodingAgentWorkspace((s) => s.saveFileContent);
  const prepareSourceCommit = useCodingAgentWorkspace((s) => s.prepareSourceCommit);
  const createSourcePullRequest = useCodingAgentWorkspace((s) => s.createSourcePullRequest);
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
          canReadFiles={canReadFiles}
          fileReadStatus={fileReadStatus}
          fileRead={fileRead}
          fileReadError={fileReadError}
          fileWriteStatus={fileWriteStatus}
          fileWriteError={fileWriteError}
          sourceCommitStatus={sourceCommitStatus}
          sourceCommitError={sourceCommitError}
          sourcePullRequestStatus={sourcePullRequestStatus}
          sourcePullRequest={sourcePullRequest}
          sourcePullRequestError={sourcePullRequestError}
          selectedFilePath={selectedFilePath}
          onOpenFile={loadFileContent}
          onSaveFile={saveFileContent}
          canPrepareCommit={canPrepareCommit}
          onPrepareCommit={prepareSourceCommit}
          onCreatePullRequest={createSourcePullRequest}
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
  canReadFiles,
  fileReadStatus,
  fileRead,
  fileReadError,
  fileWriteStatus,
  fileWriteError,
  sourceCommitStatus,
  sourceCommitError,
  sourcePullRequestStatus,
  sourcePullRequest,
  sourcePullRequestError,
  selectedFilePath,
  onOpenFile,
  onSaveFile,
  canPrepareCommit,
  onPrepareCommit,
  onCreatePullRequest,
  canCreateFollowUp,
  onAskHunkFollowUp,
}: {
  status: ReviewDetailStatus;
  snapshot: ReviewSnapshot | null;
  error: string | null;
  canReadFiles: boolean;
  fileReadStatus: FileReadStatus;
  fileRead: FileReadResponse | null;
  fileReadError: string | null;
  fileWriteStatus: FileWriteStatus;
  fileWriteError: string | null;
  sourceCommitStatus: "idle" | "preparing" | "prepared" | "error";
  sourceCommitError: string | null;
  sourcePullRequestStatus: "idle" | "creating" | "ready" | "error";
  sourcePullRequest: SourceControlCreatePullRequestResponse | null;
  sourcePullRequestError: string | null;
  selectedFilePath: string | null;
  onOpenFile: (request: FileReadRequest) => void;
  onSaveFile: (request: { projectId: string; worktreeId: string; path: string; content: string; baseEtag: string | null }) => void;
  canPrepareCommit: boolean;
  onPrepareCommit: (request: Omit<SourceControlPrepareCommitRequest, "clientRequestId">) => void;
  onCreatePullRequest: (request: Omit<SourceControlCreatePullRequestRequest, "clientRequestId">) => void;
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
  const prepareCommitPaths = snapshot.files.items.map((file) => file.path).slice(0, 100);
  const prepareCommitDisabled = sourceCommitStatus === "preparing" || prepareCommitPaths.length === 0;
  const createPullRequestDisabled = sourcePullRequestStatus === "creating";
  const sourcePullRequestUrl = canOpenPreviewExternally(sourcePullRequest?.url) ? sourcePullRequest.url : null;

  return (
    <article className="grid min-w-0 max-w-full gap-3 overflow-hidden rounded-md border p-3" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}>
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
      {canPrepareCommit ? (
        <div className="flex min-w-0 flex-wrap items-center justify-start gap-2">
          {sourceCommitStatus === "prepared" ? (
            <span className="text-xs" style={{ color: "var(--success)" }}>
              Commit prepared
            </span>
          ) : null}
          {sourceCommitStatus === "error" ? (
            <span className="text-xs" style={{ color: "var(--danger)" }}>
              {sourceCommitError ?? "Source commit could not be prepared. Refresh and try again."}
            </span>
          ) : null}
          {sourcePullRequestStatus === "ready" ? (
            <span className="text-xs" style={{ color: "var(--success)" }}>
              Pull request ready
            </span>
          ) : null}
          {sourcePullRequestStatus === "ready" && sourcePullRequestUrl ? (
            <Button
              variant="ghost"
              type="button"
              aria-label={`Open created pull request #${sourcePullRequest?.number}`}
              onClick={() => {
                void invoke("shell:open-external", { url: sourcePullRequestUrl }).catch(() => {
                  console.warn("[coding-agents] source pull request open failed");
                });
              }}
            >
              <ExternalLink size={14} />
              Open PR
            </Button>
          ) : null}
          {sourcePullRequestStatus === "error" ? (
            <span className="text-xs" style={{ color: "var(--danger)" }}>
              {sourcePullRequestError ?? "Pull request could not be created. Refresh and try again."}
            </span>
          ) : null}
          <Button
            variant="ghost"
            type="button"
            disabled={prepareCommitDisabled}
            aria-label={`Prepare commit for review PR #${snapshot.review.pullRequestNumber}`}
            onClick={() => onPrepareCommit({
              projectId: snapshot.review.projectId,
              worktreeId: snapshot.review.worktreeId,
              message: `fix: apply review updates for PR #${snapshot.review.pullRequestNumber}`,
              paths: prepareCommitPaths,
            })}
          >
            <GitCommitHorizontal size={14} />
            {sourceCommitStatus === "preparing" ? "Preparing" : "Prepare commit"}
          </Button>
          <Button
            variant="ghost"
            type="button"
            disabled={createPullRequestDisabled}
            aria-label={`Create pull request for review PR #${snapshot.review.pullRequestNumber}`}
            onClick={() => onCreatePullRequest({
              projectId: snapshot.review.projectId,
              worktreeId: snapshot.review.worktreeId,
              title: `fix: apply review updates for PR #${snapshot.review.pullRequestNumber}`,
              body: "Review updates are ready.",
            })}
          >
            <GitPullRequest size={14} />
            {sourcePullRequestStatus === "creating" ? "Creating" : "Create PR"}
          </Button>
        </div>
      ) : null}
      {snapshot.safeNotice ? (
        <p className="rounded-md border px-3 py-2 text-xs" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>
          {snapshot.safeNotice}
        </p>
      ) : null}
      {canReadFiles ? (
        <ReviewFileBrowserPanel
          key={`${snapshot.review.projectId}:${snapshot.review.worktreeId}:${snapshot.review.id}:${snapshot.updatedAt}`}
          snapshot={snapshot}
          canReadFiles={canReadFiles}
          onOpenFile={onOpenFile}
        />
      ) : null}
      <div className="grid min-w-0 gap-2">
        {snapshot.files.items.map((file, fileIndex) => (
          <div
            key={`${file.path}:${fileIndex}`}
            className="grid min-w-0 gap-2 overflow-hidden rounded-md border px-3 py-2"
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
            {canReadFiles ? (
              <div className="flex justify-end">
                <Button
                  variant="ghost"
                  type="button"
                  aria-label={`Open file ${file.path}`}
                  onClick={() => onOpenFile({
                    projectId: snapshot.review.projectId,
                    worktreeId: snapshot.review.worktreeId,
                    path: file.path,
                  })}
                >
                  <FileText size={14} />
                  Open file
                </Button>
              </div>
            ) : null}
            {selectedFilePath === file.path ? (
              <FileContentPanel
                status={fileReadStatus}
                file={fileRead}
                error={fileReadError}
                writeStatus={fileWriteStatus}
                writeError={fileWriteError}
                projectId={snapshot.review.projectId}
                worktreeId={snapshot.review.worktreeId}
                onSave={onSaveFile}
              />
            ) : null}
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
                      className="grid min-w-0 gap-1 overflow-hidden rounded-md border transition-colors duration-100"
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

function ReviewFileBrowserPanel({
  snapshot,
  canReadFiles,
  onOpenFile,
}: {
  snapshot: ReviewSnapshot;
  canReadFiles: boolean;
  onOpenFile: (request: FileReadRequest) => void;
}) {
  const [browseStatus, setBrowseStatus] = useState<FileBrowserStatus>("idle");
  const [browse, setBrowse] = useState<FileBrowseResponse | null>(null);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [searchStatus, setSearchStatus] = useState<FileBrowserStatus>("idle");
  const [searchResult, setSearchResult] = useState<FileSearchResponse | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const projectId = snapshot.review.projectId;
  const worktreeId = snapshot.review.worktreeId;

  async function loadBrowse(path?: string) {
    setBrowseStatus("loading");
    setBrowseError(null);
    try {
      const response = await invoke("runtime:browse-files", {
        projectId,
        worktreeId,
        ...(path ? { path } : {}),
        limit: 20,
      });
      setBrowse(response);
      setBrowseStatus("ready");
    } catch {
      console.warn("[coding-agents] file browse failed");
      setBrowse(null);
      setBrowseStatus("error");
      setBrowseError("File list unavailable");
    }
  }

  async function runSearch() {
    const query = searchQuery.trim();
    if (!query) return;
    setSearchStatus("loading");
    setSearchError(null);
    try {
      const response = await invoke("runtime:search-files", {
        projectId,
        worktreeId,
        query,
        limit: 20,
      });
      setSearchResult(response);
      setSearchStatus("ready");
    } catch {
      console.warn("[coding-agents] file search failed");
      setSearchResult(null);
      setSearchStatus("error");
      setSearchError("File search unavailable");
    }
  }

  const renderEntry = (
    entry: FileBrowseResponse["entries"]["items"][number],
    source: "browse" | "search",
  ) => {
    const isDirectory = entry.kind === "directory";
    const isFile = entry.kind === "file";
    return (
      <div
        key={`${source}:${entry.path}`}
        className="flex min-h-[42px] items-center justify-between gap-3 rounded-md border px-3 py-2"
        style={{ borderColor: "var(--border-subtle)", background: "var(--bg-overlay)" }}
      >
        <div className="flex min-w-0 items-center gap-2">
          {isDirectory ? (
            <FolderOpen size={14} style={{ color: "var(--text-tertiary)" }} />
          ) : (
            <FileText size={14} style={{ color: "var(--text-tertiary)" }} />
          )}
          <span className="truncate text-sm" style={{ color: "var(--text-primary)" }}>
            {entry.path}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-xs capitalize" style={{ color: "var(--text-tertiary)" }}>
            {entry.kind}
          </span>
          {isDirectory ? (
            <Button
              variant="ghost"
              type="button"
              aria-label={`Open directory ${entry.path}`}
              onClick={() => void loadBrowse(entry.path)}
            >
              <FolderOpen size={14} />
              Open
            </Button>
          ) : null}
          {canReadFiles && isFile ? (
            <Button
              variant="ghost"
              type="button"
              aria-label={`Open file ${entry.path} from ${source === "search" ? "search results" : "file browser"}`}
              onClick={() => onOpenFile({ projectId, worktreeId, path: entry.path })}
            >
              <FileText size={14} />
              Open
            </Button>
          ) : null}
        </div>
      </div>
    );
  };

  return (
    <div className="grid min-w-0 gap-2 overflow-hidden rounded-md border p-3" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-overlay)" }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h4 className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
            File browser
          </h4>
          <p className="truncate text-xs" style={{ color: "var(--text-tertiary)" }}>
            {`${projectId} / ${worktreeId}`}
          </p>
        </div>
        <Button
          variant="ghost"
          type="button"
          aria-label={`Browse workspace files for PR #${snapshot.review.pullRequestNumber}`}
          disabled={browseStatus === "loading"}
          onClick={() => void loadBrowse()}
        >
          <FolderOpen size={14} />
          {browseStatus === "loading" ? "Loading" : "Browse files"}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label="Search review workspace files"
          className="no-drag min-w-0 flex-1 basis-40 rounded-md border bg-transparent px-3 py-1.5 text-sm outline-none"
          style={{ borderColor: "var(--border-subtle)", color: "var(--text-primary)" }}
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.currentTarget.value.slice(0, 80))}
        />
        <Button
          variant="ghost"
          type="button"
          aria-label="Run review workspace file search"
          disabled={!searchQuery.trim() || searchStatus === "loading"}
          onClick={() => void runSearch()}
        >
          <Search size={14} />
          {searchStatus === "loading" ? "Searching" : "Search"}
        </Button>
      </div>
      {browseStatus === "error" ? (
        <p className="text-xs" style={{ color: "var(--danger)" }}>{browseError ?? "File list unavailable"}</p>
      ) : null}
      {browse?.entries.items.length ? (
        <div className="grid gap-1">
          {browse.entries.items.map((entry) => renderEntry(entry, "browse"))}
        </div>
      ) : null}
      {searchStatus === "error" ? (
        <p className="text-xs" style={{ color: "var(--danger)" }}>{searchError ?? "File search unavailable"}</p>
      ) : null}
      {searchResult?.matches.items.length ? (
        <div className="grid gap-1">
          {searchResult.matches.items.map((entry) => renderEntry(entry, "search"))}
        </div>
      ) : null}
    </div>
  );
}

function FileContentPanel({
  status,
  file,
  error,
  writeStatus,
  writeError,
  projectId,
  worktreeId,
  onSave,
}: {
  status: FileReadStatus;
  file: FileReadResponse | null;
  error: string | null;
  writeStatus: FileWriteStatus;
  writeError: string | null;
  projectId: string;
  worktreeId: string;
  onSave: (request: { projectId: string; worktreeId: string; path: string; content: string; baseEtag: string | null }) => void;
}) {
  const [draft, setDraft] = useState(file?.content ?? "");

  useEffect(() => {
    setDraft(file?.content ?? "");
  }, [file?.metadata.etag, file?.content]);

  if (status === "loading") {
    return (
      <p className="rounded-md border px-3 py-2 text-sm" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>
        Loading file...
      </p>
    );
  }
  if (status === "error") {
    return (
      <p className="rounded-md border px-3 py-2 text-sm" style={{ borderColor: "var(--border-subtle)", color: "var(--danger)" }}>
        {error ?? "File content unavailable"}
      </p>
    );
  }
  if (!file) return null;

  const dirty = draft !== file.content;
  const saveDisabled = writeStatus === "saving" || !dirty || file.truncated;

  return (
    <div className="grid gap-2 rounded-md border" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}>
      <div className="flex items-center justify-between gap-3 border-b px-3 py-2" style={{ borderColor: "var(--border-subtle)" }}>
        <span className="truncate text-xs" style={{ color: "var(--text-tertiary)" }}>
          {`${file.metadata.sizeBytes} bytes`}
        </span>
        <div className="flex shrink-0 items-center gap-2">
          {writeStatus === "saved" ? (
            <span className="text-xs" style={{ color: "var(--success)" }}>
              Saved
            </span>
          ) : null}
          {file.truncated ? (
            <span className="text-xs" style={{ color: "var(--warning)" }}>
              Truncated
            </span>
          ) : null}
          <Button
            variant="ghost"
            type="button"
            disabled={saveDisabled}
            aria-label={`Save file ${file.metadata.path}`}
            title={file.truncated ? "Cannot save truncated file" : `Save file ${file.metadata.path}`}
            onClick={() => onSave({
              projectId,
              worktreeId,
              path: file.metadata.path,
              content: draft,
              baseEtag: file.metadata.etag,
            })}
          >
            <Save size={14} />
            {writeStatus === "saving" ? "Saving" : "Save"}
          </Button>
        </div>
      </div>
      <textarea
        aria-label={`Edit file ${file.metadata.path}`}
        className="min-h-[240px] max-h-80 resize-y overflow-auto rounded-b-md border-0 px-3 py-2 font-mono text-xs outline-none"
        spellCheck={false}
        value={draft}
        onChange={(event) => setDraft(event.currentTarget.value)}
        style={{ background: "transparent", color: "var(--text-primary)" }}
      />
      {writeStatus === "error" ? (
        <p className="px-3 pb-2 text-xs" style={{ color: "var(--danger)" }}>
          {writeError ?? "File could not be saved. Refresh and try again."}
        </p>
      ) : null}
    </div>
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
  const runtimeScope = useConnection(codingAgentRuntimeScope);
  const status = useCodingAgentWorkspace((s) => s.status);
  const summary = useCodingAgentWorkspace((s) => s.summary);
  const error = useCodingAgentWorkspace((s) => s.error);
  const refresh = useCodingAgentWorkspace((s) => s.refresh);
  const activeThreadId = useCodingAgentWorkspace((s) => s.activeThreadId);
  const threadSnapshotStatus = useCodingAgentWorkspace((s) => s.threadSnapshotStatus);
  const threadSnapshot = useCodingAgentWorkspace((s) => s.threadSnapshot);
  const threadSnapshotError = useCodingAgentWorkspace((s) => s.threadSnapshotError);
  const reviews = useCodingAgentWorkspace((s) => s.reviews);
  const reviewFocusRequestId = useCodingAgentWorkspace((s) => s.reviewFocusRequestId);
  const loadThreadSnapshot = useCodingAgentWorkspace((s) => s.loadThreadSnapshot);
  const loadNotificationPreferences = useCodingAgentWorkspace((s) => s.loadNotificationPreferences);
  const refreshProjectWorkspace = useCodingAgentProjectWorkspace((s) => s.refresh);
  const resolveNewChatTarget = useCodingAgentProjectWorkspace((s) => s.resolveNewChatTarget);
  const projectWorkspace = useCodingAgentProjectWorkspace((s) => s.workspace);
  const viewMode = useCodingAgentProjectWorkspace((s) => s.viewMode);
  const setViewMode = useCodingAgentProjectWorkspace((s) => s.setViewMode);
  const requestComposerFocus = useCodingAgentWorkspace((s) => s.requestComposerFocus);
  const composerFocusRequestId = useCodingAgentWorkspace((s) => s.composerFocusRequestId);
  const selectedProjectId = useCodingAgentProjectWorkspace((s) => s.selectedProjectId);
  const selectedTaskId = useCodingAgentProjectWorkspace((s) => s.selectedTaskId);
  const [composerSeed, setComposerSeed] = useState<ComposerSeed | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [summaryRuntimeScope, setSummaryRuntimeScope] = useState<string | null>(null);
  const previousRuntimeScope = useRef(runtimeScope);

  useEffect(() => {
    const scopeChanged = previousRuntimeScope.current !== runtimeScope;
    previousRuntimeScope.current = runtimeScope;
    const startingSummaryRevision = useCodingAgentWorkspace.getState().summaryRevision;
    let active = true;
    setSummaryRuntimeScope(null);
    if (scopeChanged) {
      clearCodingAgentRuntimeSelection();
      setComposerSeed(null);
    }
    const unsubscribeSummary = useCodingAgentWorkspace.subscribe((state) => {
      if (
        active
        && state.status === "ready"
        && state.summaryRevision > startingSummaryRevision
      ) {
        setSummaryRuntimeScope(runtimeScope);
      }
    });
    void refresh();
    void loadNotificationPreferences();
    return () => {
      active = false;
      unsubscribeSummary();
    };
  }, [loadNotificationPreferences, refresh, runtimeScope]);

  useEffect(() => {
    if (!activeThreadId) return;
    if (threadSnapshotStatus === "ready" && threadSnapshot?.thread.id === activeThreadId) return;
    void loadThreadSnapshot(activeThreadId);
  }, [activeThreadId, loadThreadSnapshot, runtimeScope, threadSnapshot?.thread.id, threadSnapshotStatus]);

  const summaryScopeReady = summaryRuntimeScope === runtimeScope;
  const kanbanEnabled = summary
    ? capabilityEnabled(summary, "codingAgentsKanbanView")
    : false;

  if (!summaryScopeReady) {
    if (status === "error") {
      return (
        <EmptyState
          icon={<Server size={28} />}
          headline={error ?? "Runtime summary unavailable"}
          description="Refresh the workspace or check your selected runtime."
          action={<Button onClick={() => void refresh()}>Retry</Button>}
        />
      );
    }
    return (
      <EmptyState
        icon={<Server size={28} />}
        headline="Loading workspace..."
        description="Fetching runtime state from your Matrix computer."
      />
    );
  }

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
  const projectWorkspaceEnabled = capabilityEnabled(summary, "codingAgentsProjectWorkspace");

  async function openNewChat(projectId: string, taskId?: string) {
    const relation = await resolveNewChatTarget(projectId, taskId);
    if (!relation) {
      toast.error("Couldn't start a new chat here. Refresh the workspace and try again.");
      return;
    }
    setComposerSeed({
      seedId: Date.now(),
      draft: {
        ...defaultAgentThreadComposerDraft(summary!),
        ...relation,
      },
    });
    setComposerOpen(true);
    requestComposerFocus();
  }

  const showKanban = kanbanEnabled && viewMode === "kanban" && projectWorkspace;
  const reviewEnabled = capabilityEnabled(summary, "codingAgentsReview");
  const previewEnabled = capabilityEnabled(summary, "codingAgentsPreview");
  const inspectorCounts = {
    changes: reviewEnabled ? (reviews?.items.length ?? 0) : 0,
    terminal: summary.terminalSessions.items.length,
    preview: previewEnabled ? (summary.previewSessions?.items.length ?? 0) : 0,
    activity: summary.attentionThreads.items.length + summary.activeThreads.items.length,
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AgentRuntimeHeader
        summary={summary}
        onRefresh={() => {
          void (async () => {
            await refresh();
            await refreshProjectWorkspace();
          })();
        }}
      />
      <AgentProjectWorkspaceShell
        summary={summary}
        onNewChat={openNewChat}
      >
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {projectWorkspace ? (
            <header className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-2.5" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}>
              <div className="min-w-0">
                <p className="truncate text-xs font-semibold" style={{ color: "var(--text-primary)" }}>{projectWorkspace.project.label}</p>
                <p className="text-[10px]" style={{ color: "var(--text-tertiary)" }}>{showKanban ? "Project tasks" : "Project conversations"}</p>
              </div>
              {kanbanEnabled ? <AgentWorkspaceViewSwitch viewMode={viewMode} onChange={setViewMode} /> : null}
            </header>
          ) : null}
          {showKanban ? (
            <AgentKanbanWorkspace providers={summary.providers} />
          ) : (
            <div className="grid min-h-0 min-w-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-[minmax(360px,1fr)_minmax(340px,clamp(340px,34vw,520px))] lg:overflow-hidden">
              <div className="flex min-h-[460px] min-w-0 flex-col overflow-hidden border-b lg:min-h-0 lg:border-b-0 lg:border-r" style={{ borderColor: "var(--border-subtle)" }}>
                <AgentConversationView
                  status={threadSnapshotStatus}
                  snapshot={threadSnapshot}
                  error={threadSnapshotError}
                  canSendTurns={capabilityEnabled(summary, "codingAgentsSameThreadTurns")}
                />
              </div>
              <aside
                aria-label="Conversation tools"
                className="flex min-h-[520px] min-w-0 flex-col overflow-hidden lg:min-h-0"
                style={{ background: "var(--bg-secondary)" }}
              >
                <AgentConversationInspector
                  defaultTab={reviewEnabled ? "changes" : "terminal"}
                  changesFocusRequestId={reviewFocusRequestId}
                  counts={inspectorCounts}
                  toolbar={(
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Conversation tools</h2>
                        <p className="truncate text-xs" style={{ color: "var(--text-tertiary)" }}>Inspect the current project without leaving the chat</p>
                      </div>
                      {projectWorkspaceEnabled ? (
                        <Button
                          variant={composerOpen ? "subtle" : "primary"}
                          disabled={!selectedProjectId}
                          aria-label={composerOpen ? "Close new chat composer" : "New chat in selected project"}
                          onClick={() => {
                            if (composerOpen) {
                              setComposerOpen(false);
                              setComposerSeed(null);
                              return;
                            }
                            if (selectedProjectId) void openNewChat(selectedProjectId, selectedTaskId ?? undefined);
                          }}
                        >
                          {composerOpen ? "Cancel" : "New chat"}
                        </Button>
                      ) : null}
                    </div>
                  )}
                  composer={!projectWorkspaceEnabled || composerOpen ? (
                    <AgentComposer
                      summary={summary}
                      seed={composerSeed}
                      focusRequestId={composerFocusRequestId}
                      onCreated={() => {
                        if (!projectWorkspaceEnabled) return;
                        setComposerOpen(false);
                        setComposerSeed(null);
                      }}
                    />
                  ) : undefined}
                  changes={reviewEnabled ? (
                    <ReviewList
                      canReadFiles={capabilityEnabled(summary, "codingAgentsFiles")}
                      canPrepareCommit={capabilityEnabled(summary, "codingAgentsSourceControl")}
                      canCreateFollowUp={canCreateFollowUp}
                      onAskHunkFollowUp={(snapshot, selected) => {
                        setComposerSeed({
                          seedId: Date.now(),
                          draft: reviewHunkFollowUpDraft(summary, snapshot, selected),
                        });
                        setComposerOpen(true);
                      }}
                    />
                  ) : (
                    <InspectorEmptyState message="Change review is not available on this computer." />
                  )}
                  terminal={<AgentTerminalList summary={summary} />}
                  preview={previewEnabled ? (
                    <AgentPreviewList summary={summary} />
                  ) : (
                    <InspectorEmptyState message="No preview capability is available for this project." />
                  )}
                  activity={(
                    <div className="space-y-4">
                      <AttentionThreadList summary={summary} />
                      <ThreadList summary={summary} />
                      <CreatedThreadHandleList summary={summary} />
                      <ProviderList summary={summary} />
                      <NotificationPreferencesPanel />
                    </div>
                  )}
                />
              </aside>
            </div>
          )}
        </div>
      </AgentProjectWorkspaceShell>
    </div>
  );
}
