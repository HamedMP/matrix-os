import type { Context, Hono } from "hono";
import { TASK_LIMITS } from "@matrix-os/contracts/project-tasks";
import type { LegacyProjectOperationAdmission } from "../collaboration/project-fence.js";
import type { createProjectManager } from "../project-manager.js";
import { ProjectTaskCommentRepository } from "../project-tasks/comments.js";
import { ownerActor, readOwnerMember } from "../project-tasks/members.js";
import { ProjectTaskService } from "../project-tasks/service.js";
import type { ChannelReply } from "../channels/types.js";
import type { ProjectTaskRepository } from "../project-tasks/repository.js";
import { createProjectTaskAdmission, createProjectTaskRoutes } from "../project-tasks/routes.js";
import { requireRequestPrincipal } from "../request-principal.js";
import type { OwnerScope } from "../state-ops.js";
import { createTaskManager } from "../task-manager.js";
import type { WorkspaceEventPublisher } from "../workspace-event-publisher.js";
import type { ChatExecutionRootResolver } from "../chat/execution-root.js";
import type { CanonicalChatOrchestrator } from "../chat/orchestrator.js";
import type { ChatRepository } from "../chat/repository.js";
import { createCanonicalChatService } from "../chat/service.js";
import { ProjectTaskSessionRepository } from "../project-tasks/sessions.js";
import { ProjectTaskWork } from "../project-tasks/work.js";
import type { createWorktreeManager } from "../worktree-manager.js";
import { createTaskSessionPorts, type TaskSessionPortOptions } from "./project-task-sessions.js";

/**
 * Construct the board service once and mount its routes. Without the owner
 * database the routes still mount and answer 503, so the board never looks empty.
 */
export function registerProjectTaskRoutes(options: {
  app: Hono;
  homePath: string;
  repository: ProjectTaskRepository | null;
  projectManager: ReturnType<typeof createProjectManager>;
  eventPublisher: WorkspaceEventPublisher;
  /** Shared-project fences; null for an owner without collaboration. */
  collaboration: { projectOperationAdmission: LegacyProjectOperationAdmission } | null;
  getOwnerScope?(c: Context): OwnerScope;
  /** Push delivery for task notifications (the gateway's channel manager). */
  sendPush?(reply: ChannelReply): Promise<void> | void;
  /** Start work: worktrees, the owner chat store and orchestrator, and the terminal runtime. */
  worktreeManager: ReturnType<typeof createWorktreeManager>;
  chatRepository: ChatRepository | null;
  chatOrchestrator: CanonicalChatOrchestrator | null;
  chatExecutionRoots: ChatExecutionRootResolver | null;
  terminalRuntime: TaskSessionPortOptions["terminalRuntime"];
}): ProjectTaskService | null {
  const admitProjectTaskWrite = createProjectTaskAdmission(options.collaboration?.projectOperationAdmission);
  const ports = createTaskSessionPorts({
    homePath: options.homePath,
    projectManager: options.projectManager,
    worktreeManager: options.worktreeManager,
    chats: options.chatRepository ? {
      service: createCanonicalChatService(options.chatRepository, {
        ...(options.chatOrchestrator ? { orchestrator: options.chatOrchestrator } : {}),
        ...(options.chatExecutionRoots ? { executionRoots: options.chatExecutionRoots } : {}),
      }),
      repository: options.chatRepository,
    } : null,
    terminalRuntime: options.terminalRuntime,
  });
  const sessions = options.repository ? new ProjectTaskSessionRepository(options.repository.db) : null;
  const service = options.repository ? new ProjectTaskService({
    repository: options.repository,
    comments: new ProjectTaskCommentRepository(options.repository.db),
    members: async (caller) => [await readOwnerMember(options.homePath, caller.ownerScope)],
    notify: async (notification, ownerScope) => {
      // Single-owner boards: only the owner has a delivery path until organization sharing (stack 2).
      if (!options.sendPush || notification.recipient !== ownerActor(ownerScope)) return;
      await options.sendPush({
        channelId: "push", chatId: "project-tasks", ownerId: ownerScope.id, text: notification.text,
        metadata: { dedupeKey: notification.dedupeKey, projectSlug: notification.projectSlug, taskId: notification.taskId },
      });
    },
    projects: options.projectManager,
    // Read-only: the legacy files are imported once per project and left in place.
    legacyTasks: createTaskManager({ homePath: options.homePath, maxDiscoveryIds: TASK_LIMITS.tasksPerProject }),
    // Board preparation (first open, legacy import) is a write behind the same fence as task writes.
    admit: (caller, project, write) => admitProjectTaskWrite(caller, project.id, write),
    publish: (event) => options.eventPublisher.publish({
      type: event.type,
      scope: { projectSlug: event.projectSlug, taskId: event.taskId },
      payload: { revision: event.revision },
    }),
    ...(sessions ? { sessions } : {}),
    ...(options.chatRepository ? { chats: ports.chats } : {}),
    agentStatus: { terminals: ports.terminals },
  }) : null;
  const work = service && sessions ? new ProjectTaskWork({ tasks: service, sessions, ports }) : null;
  options.app.route("/", createProjectTaskRoutes({
    service,
    work,
    getOwnerScope: options.getOwnerScope ?? ((c) => ({ type: "user", id: requireRequestPrincipal(c).userId })),
    getPrincipal: (c) => requireRequestPrincipal(c),
    ...(options.collaboration ? { projectOperationAdmission: options.collaboration.projectOperationAdmission } : {}),
  }));
  return service;
}
