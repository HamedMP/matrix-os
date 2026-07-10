import { useEffect, useRef, type ReactNode } from "react";
import type { RuntimeSummary } from "@matrix-os/contracts";
import {
  clearCodingAgentThreadSelection,
  useCodingAgentWorkspace,
} from "../../stores/coding-agent-workspace";
import { useCodingAgentProjectWorkspace } from "../../stores/coding-agent-project-workspace";
import { useConnection } from "../../stores/connection";
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
  const runtimeScope = useConnection((state) => [
    state.handle ?? "signed-out",
    state.platformHost,
    state.runtimeSlot,
  ].join("|"));
  const activeThreadId = useCodingAgentWorkspace((state) => state.activeThreadId);
  const activeThread = useCodingAgentWorkspace((state) =>
    state.threadSnapshot?.thread.id === state.activeThreadId
      ? state.threadSnapshot.thread
      : null);
  const loadThreadSnapshot = useCodingAgentWorkspace((state) => state.loadThreadSnapshot);
  const previousActiveThreadId = useRef<string | null>(null);
  const attemptedExternalThreadId = useRef<string | null>(null);
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
    void hydrate(summary, runtimeScope);
  }, [enabled, hydrate, projectSignature, runtimeScope, summary.runtime.id]);

  useEffect(() => {
    if (!enabled) return;
    const currentThreadState = useCodingAgentWorkspace.getState();
    const currentActiveThreadId = currentThreadState.activeThreadId;
    if (!selectedThreadId) {
      if (
        currentActiveThreadId
        && currentThreadState.threadSnapshot?.thread.id === currentActiveThreadId
        && currentThreadState.threadSnapshot.thread.projectId
      ) {
        clearCodingAgentThreadSelection();
      }
      return;
    }
    if (status !== "ready") return;
    if (currentActiveThreadId !== selectedThreadId) {
      void loadThreadSnapshot(selectedThreadId);
    }
  }, [enabled, loadThreadSnapshot, selectedThreadId, status]);

  useEffect(() => {
    const previous = previousActiveThreadId.current;
    previousActiveThreadId.current = activeThreadId;
    if (!enabled) {
      attemptedExternalThreadId.current = null;
      return;
    }
    if (status !== "ready") return;
    if (activeThreadId !== previous) {
      attemptedExternalThreadId.current = null;
    }
    if (
      !activeThreadId
      || activeThreadId === selectedThreadId
      || attemptedExternalThreadId.current === activeThreadId
    ) {
      return;
    }
    const workspaceThread = workspace
      ? [...workspace.projectThreads.items, ...workspace.taskThreads.items]
        .find((thread) => thread.id === activeThreadId)
      : undefined;
    const summaryThread = [
      ...summary.activeThreads.items,
      ...summary.attentionThreads.items,
    ].find((thread) => thread.id === activeThreadId);
    const routeableThread = activeThread ?? workspaceThread ?? summaryThread;
    if (!routeableThread) return;
    const relation = {
      projectId: routeableThread.projectId,
      taskId: routeableThread.taskId,
    };
    attemptedExternalThreadId.current = activeThreadId;
    void focusExternalThread(activeThreadId, relation);
  }, [
    activeThread?.projectId,
    activeThread?.taskId,
    activeThreadId,
    enabled,
    focusExternalThread,
    projectSignature,
    selectedThreadId,
    status,
    summary,
    workspace,
  ]);

  if (!enabled) return children;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <AgentProjectNavigator
        summary={summary}
        workspace={workspace}
        liveThread={activeThread}
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
