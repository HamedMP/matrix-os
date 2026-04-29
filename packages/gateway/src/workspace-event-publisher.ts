import type { PreviewRecord } from "./preview-manager.js";
import type { WorkspaceError } from "./project-manager.js";
import type { TaskRecord } from "./task-manager.js";
import type { WorkspaceSessionView } from "./agent-session-manager.js";
import type { createWorkspaceEventStore } from "./workspace-events.js";

type WorkspaceEventStore = Pick<ReturnType<typeof createWorkspaceEventStore>, "publishEvent">;
type PublishEventInput = Parameters<WorkspaceEventStore["publishEvent"]>[0];

type PublishFailure = {
  ok: false;
  status: number;
  error: WorkspaceError;
};

function isPublishFailure(result: unknown): result is PublishFailure {
  return typeof result === "object" &&
    result !== null &&
    "ok" in result &&
    result.ok === false &&
    "error" in result &&
    typeof result.error === "object" &&
    result.error !== null &&
    "code" in result.error &&
    typeof result.error.code === "string";
}

export function createWorkspaceEventPublisher(options: {
  eventStore: WorkspaceEventStore;
}) {
  async function publish(input: PublishEventInput): Promise<void> {
    try {
      const result = await options.eventStore.publishEvent(input);
      if (isPublishFailure(result)) {
        console.warn("[workspace-event-publisher] Failed to publish workspace event:", result.error.code);
      }
    } catch (err: unknown) {
      console.warn(
        "[workspace-event-publisher] Unexpected workspace event publish error:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return {
    publish,

    async publishTaskCreated(task: Pick<TaskRecord, "id" | "projectSlug" | "title" | "status">): Promise<void> {
      await publish({
        type: "task.created",
        scope: { projectSlug: task.projectSlug, taskId: task.id },
        payload: { title: task.title, status: task.status },
      });
    },

    async publishTaskUpdated(task: Pick<TaskRecord, "id" | "projectSlug" | "status" | "updatedAt">): Promise<void> {
      await publish({
        type: "task.updated",
        scope: { projectSlug: task.projectSlug, taskId: task.id },
        payload: { status: task.status, updatedAt: task.updatedAt },
      });
    },

    async publishTaskDeleted(projectSlug: string, taskId: string): Promise<void> {
      await publish({
        type: "task.deleted",
        scope: { projectSlug, taskId },
        payload: {},
      });
    },

    async publishPreviewCreated(preview: Pick<PreviewRecord, "id" | "projectSlug" | "taskId" | "sessionId" | "url" | "lastStatus">): Promise<void> {
      await publish({
        type: "preview.created",
        scope: { projectSlug: preview.projectSlug, taskId: preview.taskId, sessionId: preview.sessionId, previewId: preview.id },
        payload: { url: preview.url, lastStatus: preview.lastStatus },
      });
    },

    async publishPreviewUpdated(preview: Pick<PreviewRecord, "id" | "projectSlug" | "taskId" | "sessionId" | "lastStatus" | "updatedAt">): Promise<void> {
      await publish({
        type: "preview.updated",
        scope: { projectSlug: preview.projectSlug, taskId: preview.taskId, sessionId: preview.sessionId, previewId: preview.id },
        payload: { lastStatus: preview.lastStatus, updatedAt: preview.updatedAt },
      });
    },

    async publishPreviewDeleted(projectSlug: string, previewId: string): Promise<void> {
      await publish({
        type: "preview.deleted",
        scope: { projectSlug, previewId },
        payload: {},
      });
    },

    async publishSessionStarted(session: Pick<
      WorkspaceSessionView,
      "id" | "kind" | "projectSlug" | "taskId" | "worktreeId" | "pr" | "agent" | "runtime" | "terminalSessionId"
    >): Promise<void> {
      await publish({
        type: "session.started",
        scope: { projectSlug: session.projectSlug, taskId: session.taskId, sessionId: session.id },
        payload: {
          agent: session.agent,
          kind: session.kind,
          pr: session.pr,
          runtimeStatus: session.runtime.status,
          terminalSessionId: session.terminalSessionId,
          worktreeId: session.worktreeId,
        },
      });
    },

    async publishSessionStopped(session: Pick<
      WorkspaceSessionView,
      "id" | "kind" | "projectSlug" | "taskId" | "worktreeId" | "pr" | "agent" | "runtime" | "terminalSessionId"
    >): Promise<void> {
      await publish({
        type: "session.stopped",
        scope: { projectSlug: session.projectSlug, taskId: session.taskId, sessionId: session.id },
        payload: {
          agent: session.agent,
          kind: session.kind,
          pr: session.pr,
          runtimeStatus: session.runtime.status,
          terminalSessionId: session.terminalSessionId,
          worktreeId: session.worktreeId,
        },
      });
    },
  };
}

export type WorkspaceEventPublisher = ReturnType<typeof createWorkspaceEventPublisher>;
