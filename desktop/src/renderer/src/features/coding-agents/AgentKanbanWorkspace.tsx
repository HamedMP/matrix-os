import { useEffect, useState } from "react";
import type { RuntimeSummary } from "@matrix-os/contracts";
import { AppError, toUserMessage } from "../../lib/errors";
import { useBoard, type CardStatus } from "../../stores/board";
import { useCodingAgentProjectWorkspace } from "../../stores/coding-agent-project-workspace";
import { useCodingAgentWorkspace } from "../../stores/coding-agent-workspace";
import { useConnection } from "../../stores/connection";
import { AgentKanbanBoard } from "./AgentKanbanBoard";

export function AgentKanbanWorkspace({
  providers,
}: {
  providers: RuntimeSummary["providers"];
}) {
  const api = useConnection((state) => state.api);
  const workspace = useCodingAgentProjectWorkspace((state) => state.workspace);
  const selectedProjectId = useCodingAgentProjectWorkspace((state) => state.selectedProjectId);
  const selectedTaskId = useCodingAgentProjectWorkspace((state) => state.selectedTaskId);
  const selectedThreadId = useCodingAgentProjectWorkspace((state) => state.selectedThreadId);
  const selectTask = useCodingAgentProjectWorkspace((state) => state.selectTask);
  const selectThread = useCodingAgentProjectWorkspace((state) => state.selectThread);
  const setViewMode = useCodingAgentProjectWorkspace((state) => state.setViewMode);
  const refreshWorkspace = useCodingAgentProjectWorkspace((state) => state.refresh);
  const loadThreadSnapshot = useCodingAgentWorkspace((state) => state.loadThreadSnapshot);
  const cardsByProject = useBoard((state) => state.cardsByProject);
  const boardError = useBoard((state) => state.error);
  const selectBoardProject = useBoard((state) => state.selectProject);
  const moveBoardTask = useBoard((state) => state.moveTask);
  const [movingTaskId, setMovingTaskId] = useState<string | null>(null);

  useEffect(() => {
    if (!api || !workspace) return;
    void selectBoardProject(api, workspace.project.id);
  }, [api, selectBoardProject, workspace?.project.id]);

  if (!workspace) return null;

  const projectId = workspace.project.id;
  const boardCards = selectedProjectId
    ? cardsByProject[selectedProjectId]
    : undefined;
  const canMoveTasks = Boolean(
    api
    && boardCards
    && workspace.tasks.items
      .filter((task) => task.status !== "archived")
      .every((task) => boardCards.some((card) => card.id === task.id)),
  );

  async function moveTask(taskId: string, nextStatus: CardStatus, order: number) {
    if (!api || movingTaskId) return;
    setMovingTaskId(taskId);
    try {
      await moveBoardTask(api, projectId, taskId, nextStatus, order);
      if (useCodingAgentProjectWorkspace.getState().selectedProjectId === projectId) {
        try {
          await refreshWorkspace();
        } catch (err: unknown) {
          const failureKind = err instanceof Error ? err.name : typeof err;
          console.warn(
            `[coding-agents] project workspace refresh failed after task move (${failureKind})`,
          );
        }
      }
    } finally {
      setMovingTaskId((current) => (current === taskId ? null : current));
    }
  }

  function openThread(threadId: string) {
    setViewMode("conversation");
    selectThread(threadId);
    if (useCodingAgentWorkspace.getState().activeThreadId !== threadId) {
      void loadThreadSnapshot(threadId);
    }
  }

  return (
    <AgentKanbanBoard
      workspace={workspace}
      providers={providers}
      selectedTaskId={selectedTaskId}
      selectedThreadId={selectedThreadId}
      canMoveTasks={canMoveTasks}
      movingTaskId={movingTaskId}
      mutationError={boardError ? toUserMessage(new AppError(boardError)) : null}
      onSelectTask={selectTask}
      onOpenThread={openThread}
      onMoveTask={(taskId, nextStatus, order) => {
        void moveTask(taskId, nextStatus, order);
      }}
    />
  );
}
