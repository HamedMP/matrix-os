import { AlertCircle } from "@renderer/lib/hugeicons";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type {
  AgentThreadSummary,
  CanonicalChatRecord,
  ProjectAgentWorkspace,
  RuntimeSummary,
} from "@matrix-os/contracts";
import { codingAgentRuntimeScope } from "../../../../shared/coding-agent-project-workspace";
import { createCanonicalChatClient } from "../../lib/canonical-chat-client";
import { AppError, diagnosticErrorKind } from "../../lib/errors";
import { useBoard } from "../../stores/board";
import { useConnection } from "../../stores/connection";
import { useCodingAgentWorkspace } from "../../stores/coding-agent-workspace";
import { useHermesChat, type HermesConversationSummary } from "../../stores/hermes-chat";
import { useProjectView } from "../../stores/project-view";
import { useProjectWorkspaces } from "../../stores/project-workspaces";
import { useTabs } from "../../stores/tabs";
import { capabilityEnabled } from "../coding-agents/capabilities";
import { ProviderGlyph } from "../settings/provider-glyph";
import { ProviderDriverGlyph } from "../chat/ProviderDriverGlyph";
import { ProjectChatDraft } from "./ProjectChatDraft";
import {
  buildProjectThreadListModel,
  formatRelativeTime,
  threadRailStatus,
  type ThreadRailTone,
} from "./ProjectThreadList";

const STATUS_COLORS: Record<ThreadRailTone, { background: string; color: string }> = {
  running: { background: "var(--accent-muted)", color: "var(--status-running)" },
  waiting: { background: "var(--warning-muted)", color: "var(--warning)" },
  done: { background: "var(--success-muted)", color: "var(--success)" },
  failed: { background: "var(--danger-muted)", color: "var(--danger)" },
};

const PROJECT_OVERVIEW_THREAD_LIMIT = 100;

function allThreads(
  summary: RuntimeSummary,
  projectId: string,
  workspace: ProjectAgentWorkspace | null,
  createdThreadHandles: AgentThreadSummary[],
): AgentThreadSummary[] {
  const model = buildProjectThreadListModel(workspace ?? null, summary, projectId, createdThreadHandles);
  const combined = [
    ...model.projectThreads,
    ...model.taskGroups.flatMap((group) => group.threads),
    ...model.otherThreads,
  ].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  const deduped = new Map<string, AgentThreadSummary>();
  for (const thread of combined) {
    if (deduped.has(thread.id)) continue;
    deduped.set(thread.id, thread);
  }
  return [...deduped.values()];
}

type ProjectOverviewSession =
  | { kind: "coding"; id: string; updatedAt: number; thread: AgentThreadSummary }
  | { kind: "chat"; id: string; updatedAt: number; conversation: HermesConversationSummary }
  | { kind: "canonical"; id: string; updatedAt: number; record: CanonicalChatRecord };

function projectSessions(
  threads: AgentThreadSummary[],
  conversations: HermesConversationSummary[],
): ProjectOverviewSession[] {
  return [
    ...threads.map((thread): ProjectOverviewSession => ({
      kind: "coding",
      id: thread.id,
      updatedAt: Date.parse(thread.updatedAt),
      thread,
    })),
    ...conversations.map((conversation): ProjectOverviewSession => ({
      kind: "chat",
      id: conversation.id,
      updatedAt: conversation.updatedAt,
      conversation,
    })),
  ]
    .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
    .slice(0, PROJECT_OVERVIEW_THREAD_LIMIT);
}

function canonicalProjectSessions(records: CanonicalChatRecord[]): ProjectOverviewSession[] {
  return records
    .map((record): ProjectOverviewSession => ({
      kind: "canonical",
      id: record.chat.id,
      updatedAt: Date.parse(record.chat.updatedAt),
      record,
    }))
    .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
    .slice(0, PROJECT_OVERVIEW_THREAD_LIMIT);
}

export default function ProjectOverview({
  projectId,
  projectLabel,
  summary,
  active,
  description,
  viewSwitch,
}: {
  projectId: string;
  projectLabel: string;
  summary: RuntimeSummary | null;
  active: boolean;
  description?: string;
  viewSwitch: ReactNode;
}) {
  const runtimeScope = useConnection(codingAgentRuntimeScope);
  const api = useConnection((state) => state.api);
  const canonicalProjectId = useBoard((state) => (
    state.projects.find((project) => project.slug === projectId || project.id === projectId)?.id
      ?? projectId
  ));
  const canonicalClient = useMemo(
    () => api?.baseUrl ? createCanonicalChatClient(api) : null,
    [api],
  );
  const [canonicalStatus, setCanonicalStatus] = useState<"unavailable" | "loading" | "ready" | "error">(
    canonicalClient ? "loading" : "unavailable",
  );
  const [canonicalChats, setCanonicalChats] = useState<CanonicalChatRecord[]>([]);
  const [canonicalLoadRevision, setCanonicalLoadRevision] = useState(0);
  const workspaceEntry = useProjectWorkspaces((state) => state.entries[projectId]);
  const ensureWorkspace = useProjectWorkspaces((state) => state.ensure);
  const refreshWorkspace = useProjectWorkspaces((state) => state.refresh);
  const workspaceEnabled = summary ? capabilityEnabled(summary, "codingAgentsProjectWorkspace") : false;
  const canCreate = summary ? capabilityEnabled(summary, "codingAgentsThreadCreate") : false;
  const setSelectedThread = useProjectView((state) => state.setSelectedThread);
  const setView = useProjectView((state) => state.setView);
  const composerFocusRequestId = useCodingAgentWorkspace((state) => state.composerFocusRequestId);
  const createdThreadHandles = useCodingAgentWorkspace((state) => state.createdThreadHandles);
  const hermesConversations = useHermesChat((state) => state.conversations);
  const refreshHermesConversations = useHermesChat((state) => state.refreshConversations);
  const threads = useMemo(
    () => summary
      ? allThreads(summary, projectId, workspaceEntry?.workspace ?? null, createdThreadHandles)
      : [],
    [createdThreadHandles, projectId, summary, workspaceEntry?.workspace],
  );
  const projectHermesConversations = useMemo(() => hermesConversations.filter((conversation) => (
    conversation.context?.projectId === projectId
  )), [hermesConversations, projectId]);
  const legacySessions = useMemo(
    () => projectSessions(threads, projectHermesConversations),
    [projectHermesConversations, threads],
  );
  const sessions = useMemo(() => (
    canonicalStatus === "ready"
      ? canonicalProjectSessions(canonicalChats)
      : (canonicalStatus === "loading" || canonicalStatus === "error") && canonicalClient
        ? []
        : legacySessions
  ), [canonicalChats, canonicalClient, canonicalStatus, legacySessions]);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const hermesRefreshScopeRef = useRef<string | null>(null);

  useEffect(() => {
    let current = true;
    if (!canonicalClient) {
      setCanonicalStatus("unavailable");
      setCanonicalChats([]);
      return () => { current = false; };
    }
    setCanonicalStatus("loading");
    void canonicalClient.list({ projectId: canonicalProjectId, limit: PROJECT_OVERVIEW_THREAD_LIMIT }).then((page) => {
      if (!current) return;
      setCanonicalChats(page.items);
      setCanonicalStatus("ready");
    }).catch((error: unknown) => {
      if (!current) return;
      console.warn("[project-overview] canonical chat list failed:", diagnosticErrorKind(error));
      setCanonicalChats([]);
      setCanonicalStatus(error instanceof AppError && error.category === "notFound"
        ? "unavailable"
        : "error");
    });
    return () => { current = false; };
  }, [canonicalClient, canonicalLoadRevision, canonicalProjectId]);

  useEffect(() => {
    if (!active) {
      hermesRefreshScopeRef.current = null;
      return;
    }
    if (!api) return;
    const refreshScope = `${runtimeScope}:${projectId}`;
    if (hermesRefreshScopeRef.current === refreshScope) return;
    hermesRefreshScopeRef.current = refreshScope;
    void refreshHermesConversations(api);
  }, [active, api, projectId, refreshHermesConversations, runtimeScope]);

  useEffect(() => {
    if (!active || !workspaceEnabled) return;
    useProjectWorkspaces.getState().ensureRuntimeScope(runtimeScope);
    void ensureWorkspace(projectId);
  }, [active, ensureWorkspace, projectId, runtimeScope, workspaceEnabled]);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <main className="min-h-0 flex-1 overflow-y-auto" style={{ background: "var(--bg-app)" }}>
      <div className="mx-auto flex w-full max-w-[980px] flex-col px-8 pb-12 pt-8">
        <div className="mb-6 flex items-start gap-4">
          <div className="min-w-0 flex-1">
          <h1 className="text-[24px] font-semibold leading-[32px] tracking-[-0.6px]" style={{ color: "var(--text-primary)" }}>
            {projectLabel}
          </h1>
          {description ? <p className="mt-2 text-[16px] leading-[28px]" style={{ color: "var(--text-tertiary)" }}>{description}</p> : null}
          </div>
          {viewSwitch}
        </div>

        {summary && workspaceEnabled && (canonicalStatus === "ready" || canonicalStatus === "unavailable") ? (
          <div className="mb-6">
            <ProjectChatDraft
              summary={summary}
              projectId={projectId}
              projectLabel={projectLabel}
              active={active}
              seed={null}
              focusRequestId={composerFocusRequestId}
              typeToStartEnabled={canCreate}
              presentation={sessions.length === 0
                && workspaceEntry?.status !== "loading"
                && workspaceEntry?.status !== "error"
                ? "hero"
                : "landing"}
              heroHeadline="What should we build today?"
              canonicalClient={canonicalStatus === "ready" ? canonicalClient : null}
              canonicalProjectId={canonicalProjectId}
              onCanonicalCreated={(chatId, label) => {
                setView(projectId, "chats");
                useTabs.getState().openTab({
                  kind: "project",
                  projectSlug: projectId,
                  chatId,
                  title: projectLabel,
                });
                useTabs.getState().recordRecentCanonicalChat(chatId, label, canonicalProjectId);
              }}
              onCreated={(threadId, label) => {
                setSelectedThread(projectId, threadId);
                setView(projectId, "chats");
                useTabs.getState().recordRecentConversation(threadId, label);
              }}
            />
          </div>
        ) : summary && workspaceEnabled && canonicalStatus === "loading" ? (
          <div className="mb-6 h-[126px] animate-pulse rounded-[var(--radius-xl)] border" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }} aria-label="Loading Chat composer" />
        ) : null}

        <section aria-label={`${projectLabel} sessions`}>
          {canonicalStatus === "error" ? (
            <div role="alert" className="flex items-center gap-3 py-6 text-sm" style={{ color: "var(--text-secondary)" }}>
              <AlertCircle size={15} style={{ color: "var(--warning)" }} />
              <span>Project chats are temporarily unavailable.</span>
              <button
                type="button"
                onClick={() => setCanonicalLoadRevision((revision) => revision + 1)}
                className="rounded-md border px-2 py-1 text-xs font-medium"
                style={{ borderColor: "var(--border-default)" }}
              >
                Retry
              </button>
            </div>
          ) : null}
          {!summary && workspaceEntry?.status !== "error" ? (
            <div role="status" className="py-6">
              <p className="text-sm font-medium" style={{ color: "var(--text-secondary)" }}>
                Loading project workspace…
              </p>
              <p className="mt-1 text-xs" style={{ color: "var(--text-tertiary)" }}>
                Fetching chat and workspace capabilities from this Matrix computer.
              </p>
            </div>
          ) : null}
          {(workspaceEntry?.status === "loading" || canonicalStatus === "loading") && sessions.length === 0 ? (
            <p className="py-6 text-sm" style={{ color: "var(--text-tertiary)" }}>Loading recent sessions…</p>
          ) : null}
          {workspaceEntry?.status === "error" && sessions.length === 0 ? (
            <div className="flex items-center gap-3 py-6 text-sm" style={{ color: "var(--text-secondary)" }}>
              <AlertCircle size={15} style={{ color: "var(--warning)" }} />
              <span>Project sessions are unavailable.</span>
              <button
                type="button"
                onClick={() => void refreshWorkspace(projectId)}
                className="rounded-md border px-2 py-1 text-xs font-medium"
                style={{ borderColor: "var(--border-default)" }}
              >
                Retry
              </button>
            </div>
          ) : null}
          {summary && canonicalStatus !== "loading" && canonicalStatus !== "error" && workspaceEntry?.status !== "loading" && workspaceEntry?.status !== "error" && sessions.length === 0 ? (
            <p className="py-6 text-sm" style={{ color: "var(--text-tertiary)" }}>No sessions yet. Start one above.</p>
          ) : null}

          <div>
            {sessions.map((session) => {
              if (session.kind === "canonical") {
                const { record } = session;
                const relative = formatRelativeTime(record.chat.updatedAt, nowMs);
                const driverKind = record.providerBinding?.driverKind;
                const providerLabel = driverKind?.replace(/_/g, " ") ?? "Agent";
                const running = Boolean(record.activeRun);
                return (
                  <button
                    key={`canonical:${record.chat.id}`}
                    type="button"
                    aria-label={`Open chat ${record.chat.title}`}
                    onClick={() => {
                      setSelectedThread(projectId, null);
                      setView(projectId, "chats");
                      useTabs.getState().openTab({
                        kind: "project",
                        projectSlug: projectId,
                        chatId: record.chat.id,
                        title: projectLabel,
                      });
                      useTabs.getState().recordRecentCanonicalChat(
                        record.chat.id,
                        record.chat.title,
                        canonicalProjectId,
                      );
                    }}
                    className="group flex w-full items-center gap-3 border-b px-3 py-3.5 text-left outline-none transition-colors last:border-b-0 hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                    style={{ borderColor: "var(--border-subtle)" }}
                  >
                    <span aria-label={`${providerLabel} provider`} title={providerLabel} className="shrink-0">
                      {driverKind
                        ? <ProviderDriverGlyph kind={driverKind} size={15} />
                        : <ProviderGlyph kind="custom" compact />}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[16px] font-normal leading-[28px]" style={{ color: "var(--text-primary)" }}>{record.chat.title}</span>
                    {running ? (
                      <span className="rounded-full px-2 py-0.5 text-[10px] font-semibold" style={STATUS_COLORS.running}>Running</span>
                    ) : null}
                    {relative ? <span className="w-16 shrink-0 text-right text-[12px] font-medium leading-[16px] tabular-nums" style={{ color: "var(--text-tertiary)" }}>{relative}</span> : null}
                  </button>
                );
              }
              if (session.kind === "chat") {
                const conversation = session.conversation;
                const relative = formatRelativeTime(new Date(conversation.updatedAt).toISOString(), nowMs);
                return (
                  <button
                    key={`chat:${conversation.id}`}
                    type="button"
                    aria-label={`Open chat ${conversation.title}`}
                    onClick={() => {
                      if (!api) return;
                      void useHermesChat.getState().openConversation(api, conversation.id).then((opened) => {
                        if (!opened) return;
                        setSelectedThread(projectId, null);
                        setView(projectId, "chats");
                      });
                    }}
                    className="group flex w-full items-center gap-3 border-b px-3 py-3.5 text-left outline-none transition-colors last:border-b-0 hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                    style={{ borderColor: "var(--border-subtle)" }}
                  >
                    <span aria-label="Hermes provider" title="Hermes" className="shrink-0">
                      <ProviderDriverGlyph kind="hermes" size={15} />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[16px] font-normal leading-[28px]" style={{ color: "var(--text-primary)" }}>{conversation.title}</span>
                    {relative ? <span className="w-16 shrink-0 text-right text-[12px] font-medium leading-[16px] tabular-nums" style={{ color: "var(--text-tertiary)" }}>{relative}</span> : null}
                  </button>
                );
              }
              const thread = session.thread;
              const status = threadRailStatus(thread);
              const relative = formatRelativeTime(thread.updatedAt, nowMs);
              const provider = summary?.providers.find((candidate) => candidate.id === thread.providerId);
              const providerLabel = provider?.displayName ?? thread.providerId;
              return (
                <button
                  key={`coding:${thread.id}`}
                  type="button"
                  aria-label={`Open session ${thread.title}`}
                  onClick={() => {
                    setSelectedThread(projectId, thread.id);
                    setView(projectId, "chats");
                  }}
                  className="group flex w-full items-center gap-3 border-b px-3 py-3.5 text-left outline-none transition-colors last:border-b-0 hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                  style={{ borderColor: "var(--border-subtle)" }}
                >
                  <span aria-label={`${providerLabel} provider`} title={providerLabel} className="shrink-0">
                    <ProviderGlyph kind={provider?.kind ?? "custom"} compact />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[16px] font-normal leading-[28px]" style={{ color: "var(--text-primary)" }}>{thread.title}</span>
                  {status ? (
                    <span className="rounded-full px-2 py-0.5 text-[10px] font-semibold" style={STATUS_COLORS[status.tone]}>{status.label}</span>
                  ) : null}
                  {relative ? <span className="w-16 shrink-0 text-right text-[12px] font-medium leading-[16px] tabular-nums" style={{ color: "var(--text-tertiary)" }}>{relative}</span> : null}
                </button>
              );
            })}
          </div>
        </section>
      </div>
    </main>
  );
}
