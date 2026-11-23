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
import { createTaskSessionCredentials } from "../project-tasks/session-credentials.js";
import { ProjectTaskSessionRepository } from "../project-tasks/sessions.js";
import { createProjectChatHook } from "../project-tasks/task-chats.js";
import { ProjectTaskWork } from "../project-tasks/work.js";
import type { createWorktreeManager } from "../worktree-manager.js";
import { createTaskSessionPorts, type TaskSessionPortOptions } from "./project-task-sessions.js";
import {
  createProjectTaskAgentBindings, createProjectTaskKernelBindings, type ProjectTaskInternalEnv,
} from "./project-task-agents.js";

export { createProjectTaskAgentAccess } from "./project-task-agents.js";

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
  /** Receives the kernel chat runs' board binding once the board exists (spec 2699 section 5). */
  agentAccess?: { bind(bindings: ReturnType<typeof createProjectTaskKernelBindings>): void };
}): ProjectTaskService | null {
  const admitProjectTaskWrite = createProjectTaskAdmission(options.collaboration?.projectOperationAdmission);
  // One signer for task tabs and the board binding; its secret is read or created on first use.
  const sessionCredentials = createTaskSessionCredentials({ homePath: options.homePath });
  const ports = createTaskSessionPorts({
    homePath: options.homePath,
    sessionCredentials,
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
  if (service && options.repository && options.chatRepository) {
    // Every task is a chat: project chat writes create, rename, archive, move and delete their tasks in the same transaction.
    options.chatRepository.setProjectChatHook(createProjectChatHook({ repository: options.repository, projects: options.projectManager }));
    options.chatRepository.addOutboxObserver(({ owner, event }) => {
      if (owner.type !== "personal") return;
      service.chatChanged({ type: "user", id: owner.ownerId }, event.chatId, event.eventType).catch((error: unknown) => {
        console.warn("[project-tasks] chat change not applied", error instanceof Error ? error.name : typeof error);
      });
    });
  }
  const work = service && sessions ? new ProjectTaskWork({ tasks: service, sessions, ports }) : null;
  const shared = {
    service,
    work,
    sessionTask: sessions
      ? (ownerScope: OwnerScope, binding: { projectId: string; ref: string }) => sessions.taskForSession(ownerScope.id, binding.projectId, binding.ref)
      : undefined,
    ...(options.collaboration ? { projectOperationAdmission: options.collaboration.projectOperationAdmission } : {}),
  };
  options.app.route("/", createProjectTaskRoutes({
    ...shared,
    getOwnerScope: options.getOwnerScope ?? ((c) => ({ type: "user", id: requireRequestPrincipal(c).userId })),
    getPrincipal: (c) => requireRequestPrincipal(c),
    // Task tab and chat run credentials stay inside their own project, as agent:<session ref>.
    getAgentBinding: createProjectTaskAgentBindings({ projects: options.projectManager, credentials: sessionCredentials }),
  }));
  // Kernel chat runs call the same routes in process; the binding comes only from this env.
  const internal = createProjectTaskRoutes({
    ...shared,
    getOwnerScope: (c) => (c.env as ProjectTaskInternalEnv).projectTaskAgent.ownerScope,
    getAgentBinding: async (c) => (c.env as ProjectTaskInternalEnv).projectTaskAgent.binding,
  });
  options.agentAccess?.bind(createProjectTaskKernelBindings({ routes: internal, projects: options.projectManager, sessions }));
  return service;
}
