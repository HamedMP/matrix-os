import { AgentThreadSummarySchema, type AgentThreadSummary } from "@matrix-os/contracts";
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
type SessionLifecyclePick = Pick<
  WorkspaceSessionView,
  "id" | "kind" | "projectSlug" | "taskId" | "worktreeId" | "pr" | "agent" | "runtime" | "terminalSessionId" | "ownerId"
>;

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
  onSessionStopped?: (session: SessionLifecyclePick) => Promise<void> | void;
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

  function logSessionStoppedHookFailure(err: unknown): void {
    console.warn(
      "[workspace-event-publisher] Session stopped hook failed:",
      err instanceof Error ? err.message : String(err),
    );
  }

  function notifySessionStopped(session: SessionLifecyclePick): void {
    try {
      const result = options.onSessionStopped?.(session);
      if (result && typeof result === "object" && "then" in result) {
        void Promise.resolve(result).catch(logSessionStoppedHookFailure);
      }
    } catch (err: unknown) {
      logSessionStoppedHookFailure(err);
    }
  }

  return {
    publish,

    async publishCodingAgentThreadProjection(change: {
      type: "created" | "updated" | "removed";
      thread: AgentThreadSummary;
    }): Promise<void> {
      const thread = AgentThreadSummarySchema.parse(change.thread);
      if (!thread.projectId) return;
      await publish({
        type: `coding-agent.thread.${change.type}`,
        scope: { projectSlug: thread.projectId, taskId: thread.taskId },
        payload: {
          attention: thread.attention,
          providerId: thread.providerId,
          status: thread.status,
          threadId: thread.id,
          updatedAt: thread.updatedAt,
        },
      });
    },

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

    async publishSessionStarted(session: SessionLifecyclePick): Promise<void> {
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

    async publishSessionStopped(session: SessionLifecyclePick): Promise<void> {
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
      notifySessionStopped(session);
    },
  };
}

export type WorkspaceEventPublisher = ReturnType<typeof createWorkspaceEventPublisher>;
