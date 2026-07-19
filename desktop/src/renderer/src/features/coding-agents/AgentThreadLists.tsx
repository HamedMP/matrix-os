import { ChevronRight, GitBranch, SquareTerminal } from "lucide-react";
import type { AgentThreadSummary, RuntimeSummary } from "@matrix-os/contracts";
import { Button } from "../../design/primitives";
import { useCodingAgentWorkspace } from "../../stores/coding-agent-workspace";
import { useTabs } from "../../stores/tabs";
import { AgentWorkspaceSection as Section } from "./AgentWorkspaceSection";

export function ThreadList({
  summary,
  onOpenThread,
}: {
  summary: RuntimeSummary;
  onOpenThread?: (thread: AgentThreadSummary) => void;
}) {
  const openTab = useTabs((s) => s.openTab);
  const activeThreadId = useCodingAgentWorkspace((s) => s.activeThreadId);
  const loadThreadSnapshot = useCodingAgentWorkspace((s) => s.loadThreadSnapshot);
  const findAttachableSessionName = (sessionId: string): string | null =>
    summary.terminalSessions.items.find((session) => session.id === sessionId && session.attachable)?.name ?? null;
  const openThread = onOpenThread ?? ((thread: AgentThreadSummary) => void loadThreadSnapshot(thread.id));

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
                  onClick={() => openThread(thread)}
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

export function CreatedThreadHandleList({
  summary,
  onOpenThread,
}: {
  summary: RuntimeSummary;
  onOpenThread?: (thread: AgentThreadSummary) => void;
}) {
  const createdThreadHandles = useCodingAgentWorkspace((s) => s.createdThreadHandles);
  const activeThreadId = useCodingAgentWorkspace((s) => s.activeThreadId);
  const loadThreadSnapshot = useCodingAgentWorkspace((s) => s.loadThreadSnapshot);
  const summaryThreadIds = new Set([
    ...summary.activeThreads.items.map((thread) => thread.id),
    ...summary.attentionThreads.items.map((thread) => thread.id),
  ]);
  const visibleHandles = createdThreadHandles.filter((thread) => !summaryThreadIds.has(thread.id));
  const openThread = onOpenThread ?? ((thread: AgentThreadSummary) => void loadThreadSnapshot(thread.id));

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
              onClick={() => openThread(thread)}
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
