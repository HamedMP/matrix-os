import { AlertCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { AgentThreadSummary, ProjectAgentWorkspace, RuntimeSummary } from "@matrix-os/contracts";
import { codingAgentRuntimeScope } from "../../../../shared/coding-agent-project-workspace";
import { useConnection } from "../../stores/connection";
import { useCodingAgentWorkspace } from "../../stores/coding-agent-workspace";
import { useProjectView } from "../../stores/project-view";
import { useProjectWorkspaces } from "../../stores/project-workspaces";
import { useTabs } from "../../stores/tabs";
import { capabilityEnabled } from "../coding-agents/capabilities";
import { ProviderGlyph } from "../settings/provider-glyph";
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

function allThreads(summary: RuntimeSummary, projectId: string, workspace: ProjectAgentWorkspace | null): AgentThreadSummary[] {
  const model = buildProjectThreadListModel(workspace ?? null, summary, projectId);
  const combined = [
    ...model.projectThreads,
    ...model.taskGroups.flatMap((group) => group.threads),
    ...model.otherThreads,
  ].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  const deduped = new Map<string, AgentThreadSummary>();
  for (const thread of combined) {
    if (deduped.has(thread.id)) continue;
    if (deduped.size >= PROJECT_OVERVIEW_THREAD_LIMIT) break;
    deduped.set(thread.id, thread);
  }
  return [...deduped.values()];
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
  const workspaceEntry = useProjectWorkspaces((state) => state.entries[projectId]);
  const ensureWorkspace = useProjectWorkspaces((state) => state.ensure);
  const refreshWorkspace = useProjectWorkspaces((state) => state.refresh);
  const workspaceEnabled = summary ? capabilityEnabled(summary, "codingAgentsProjectWorkspace") : false;
  const canCreate = summary ? capabilityEnabled(summary, "codingAgentsThreadCreate") : false;
  const setSelectedThread = useProjectView((state) => state.setSelectedThread);
  const setView = useProjectView((state) => state.setView);
  const composerFocusRequestId = useCodingAgentWorkspace((state) => state.composerFocusRequestId);
  const threads = useMemo(
    () => summary ? allThreads(summary, projectId, workspaceEntry?.workspace ?? null) : [],
    [projectId, summary, workspaceEntry?.workspace],
  );
  const [nowMs, setNowMs] = useState(() => Date.now());

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
          <h1 className="text-[32px] leading-none tracking-[-0.035em]" style={{ color: "var(--text-primary)", fontFamily: "var(--font-editorial)" }}>
            {projectLabel}
          </h1>
          {description ? <p className="mt-2 text-sm" style={{ color: "var(--text-tertiary)" }}>{description}</p> : null}
          </div>
          {viewSwitch}
        </div>

        {summary && workspaceEnabled ? (
          <div className="mb-6">
            <ProjectChatDraft
              summary={summary}
              projectId={projectId}
              projectLabel={projectLabel}
              active={active}
              seed={null}
              focusRequestId={composerFocusRequestId}
              typeToStartEnabled={canCreate}
              presentation="landing"
              onCreated={(threadId, label) => {
                setSelectedThread(projectId, threadId);
                setView(projectId, "chats");
                useTabs.getState().recordRecentConversation(threadId, label);
              }}
            />
          </div>
        ) : null}

        <section aria-label={`${projectLabel} sessions`}>
          {workspaceEntry?.status === "loading" && threads.length === 0 ? (
            <p className="py-6 text-sm" style={{ color: "var(--text-tertiary)" }}>Loading recent sessions…</p>
          ) : null}
          {workspaceEntry?.status === "error" && threads.length === 0 ? (
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
          {summary && workspaceEntry?.status !== "loading" && workspaceEntry?.status !== "error" && threads.length === 0 ? (
            <p className="py-6 text-sm" style={{ color: "var(--text-tertiary)" }}>No sessions yet. Start one above.</p>
          ) : null}

          <div>
            {threads.map((thread) => {
              const status = threadRailStatus(thread);
              const relative = formatRelativeTime(thread.updatedAt, nowMs);
              const provider = summary?.providers.find((candidate) => candidate.id === thread.providerId);
              const providerLabel = provider?.displayName ?? thread.providerId;
              return (
                <button
                  key={thread.id}
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
                  <span className="min-w-0 flex-1 truncate text-sm font-medium" style={{ color: "var(--text-primary)" }}>{thread.title}</span>
                  {status ? (
                    <span className="rounded-full px-2 py-0.5 text-[10px] font-semibold" style={STATUS_COLORS[status.tone]}>{status.label}</span>
                  ) : null}
                  {relative ? <span className="w-16 shrink-0 text-right text-xs tabular-nums" style={{ color: "var(--text-tertiary)" }}>{relative}</span> : null}
                </button>
              );
            })}
          </div>
        </section>
      </div>
    </main>
  );
}
