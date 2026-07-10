import { useEffect, useRef, type ReactNode } from "react";
import type { RuntimeSummary } from "@matrix-os/contracts";
import {
  clearCodingAgentThreadSelection,
  useCodingAgentWorkspace,
} from "../../stores/coding-agent-workspace";
import { useCodingAgentProjectWorkspace } from "../../stores/coding-agent-project-workspace";
import { AgentProjectNavigator } from "./AgentProjectNavigator";

function capabilityEnabled(summary: RuntimeSummary, id: string): boolean {
  return summary.capabilities.some(
    (capability) => capability.id === id && capability.enabled,
  );
}

export function AgentProjectWorkspaceShell({
  summary,
  children,
  onNewChat,
}: {
  summary: RuntimeSummary;
  children: ReactNode;
  onNewChat: (projectId: string, taskId?: string) => void;
}) {
  const status = useCodingAgentProjectWorkspace((state) => state.status);
  const workspace = useCodingAgentProjectWorkspace((state) => state.workspace);
  const error = useCodingAgentProjectWorkspace((state) => state.error);
  const selectedProjectId = useCodingAgentProjectWorkspace(
    (state) => state.selectedProjectId,
  );
  const selectedTaskId = useCodingAgentProjectWorkspace((state) => state.selectedTaskId);
  const selectedThreadId = useCodingAgentProjectWorkspace(
    (state) => state.selectedThreadId,
  );
  const hydrate = useCodingAgentProjectWorkspace((state) => state.hydrate);
  const selectProject = useCodingAgentProjectWorkspace((state) => state.selectProject);
  const selectTask = useCodingAgentProjectWorkspace((state) => state.selectTask);
  const selectThread = useCodingAgentProjectWorkspace((state) => state.selectThread);
  const focusExternalThread = useCodingAgentProjectWorkspace(
    (state) => state.focusExternalThread,
  );
  const activeThreadId = useCodingAgentWorkspace((state) => state.activeThreadId);
  const activeThread = useCodingAgentWorkspace((state) =>
    state.threadSnapshot?.thread.id === state.activeThreadId
      ? state.threadSnapshot.thread
      : null);
  const loadThreadSnapshot = useCodingAgentWorkspace((state) => state.loadThreadSnapshot);
  const previousActiveThreadId = useRef<string | null>(null);
  const pendingExternalThreadId = useRef<string | null>(null);
  const projectSignature = [
    ...summary.projects.items.map((project) => [
      project.id,
      project.taskCount,
      project.threadCount,
      project.attentionCount,
      project.updatedAt ?? "",
    ].join(":")),
  ].join("|");
  const enabled = capabilityEnabled(summary, "codingAgentsProjectWorkspace");

  useEffect(() => {
    if (!enabled) return;
    void hydrate(summary);
  }, [enabled, hydrate, projectSignature, summary.runtime.id]);

  useEffect(() => {
    if (!enabled || status !== "ready") return;
    const currentActiveThreadId = useCodingAgentWorkspace.getState().activeThreadId;
    if (!selectedThreadId) {
      if (currentActiveThreadId) clearCodingAgentThreadSelection();
      return;
    }
    if (currentActiveThreadId !== selectedThreadId) {
      void loadThreadSnapshot(selectedThreadId);
    }
  }, [enabled, loadThreadSnapshot, selectedThreadId, status]);

  useEffect(() => {
    const previous = previousActiveThreadId.current;
    previousActiveThreadId.current = activeThreadId;
    if (!enabled) {
      pendingExternalThreadId.current = null;
      return;
    }
    if (activeThreadId !== previous) {
      pendingExternalThreadId.current = activeThreadId !== selectedThreadId
        ? activeThreadId
        : null;
    }
    if (
      !activeThreadId
      || pendingExternalThreadId.current !== activeThreadId
      || activeThreadId === selectedThreadId
    ) {
      return;
    }
    const relation = activeThread
      ? { projectId: activeThread.projectId, taskId: activeThread.taskId }
      : undefined;
    void focusExternalThread(activeThreadId, relation).then(() => {
      if (
        useCodingAgentProjectWorkspace.getState().selectedThreadId === activeThreadId
      ) {
        pendingExternalThreadId.current = null;
      }
    });
  }, [
    activeThread?.projectId,
    activeThread?.taskId,
    activeThreadId,
    enabled,
    focusExternalThread,
    projectSignature,
    selectedThreadId,
  ]);

  if (!enabled) return children;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <AgentProjectNavigator
        summary={summary}
        workspace={workspace}
        status={status}
        error={error}
        selectedProjectId={selectedProjectId}
        selectedTaskId={selectedTaskId}
        selectedThreadId={selectedThreadId}
        canCreate={capabilityEnabled(summary, "codingAgentsThreadCreate")}
        onSelectProject={(projectId) => {
          void selectProject(projectId);
        }}
        onSelectTask={selectTask}
        onSelectThread={selectThread}
        onNewChat={onNewChat}
      />
      <main className="flex min-h-0 min-w-[320px] flex-1 flex-col overflow-hidden">
        {children}
      </main>
    </div>
  );
}
