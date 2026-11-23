/**
 * Who a session-bound board caller is (spec 2699 section 5): a task terminal tab presenting
 * the local terminal token plus its gateway-signed task session credential, a chat run
 * presenting its run token, or a kernel chat run inside this process. Each resolves to one
 * project and acts as `agent:<session ref>`.
 */
import type { Context, Hono } from "hono";
import { createProjectTaskHttpClient } from "@matrix-os/contracts/project-task-client";
import { TASK_SESSION_TOKEN_HEADER, TaskSessionRefSchema } from "@matrix-os/contracts/project-tasks";
import type { ProjectTaskKernelBinding } from "@matrix-os/kernel";
import { MATRIX_MCP_RUN_CONTEXT_KEY, type MatrixMcpRunContext } from "../chat/matrix-mcp-launch.js";
import type { ProjectTaskAgentBinding } from "../project-tasks/agent-access.js";
import { ProjectTaskError } from "../project-tasks/errors.js";
import type { TaskSessionCredentials } from "../project-tasks/session-credentials.js";
import type { ProjectTaskSessionRepository } from "../project-tasks/sessions.js";
import type { OwnerScope } from "../state-ops.js";
import { LOCAL_TERMINAL_AGENT_CONTEXT_KEY } from "../terminal-agent/local-token.js";

type ProjectResult = { ok: true; project: { id: string; slug: string } } | { ok: false; status: number };

export interface ProjectTaskAgentProjects {
  getProject(slug: string, ownerScope?: OwnerScope): Promise<ProjectResult>;
  getProjectById(ownerScope: OwnerScope, projectId: string): Promise<ProjectResult>;
}

function forbidden(): ProjectTaskError {
  return new ProjectTaskError("task_forbidden");
}

function project(result: ProjectResult): { id: string; slug: string } {
  if (result.ok) return result.project;
  if (result.status === 404 || result.status === 400) throw forbidden();
  throw new ProjectTaskError("board_unavailable");
}

/**
 * The board binding for a request, from what gateway auth established: the local
 * terminal token binds through the tab's signed task session credential, a chat run
 * token to its run's project. An owner credential has none. A bounded credential
 * without a verified project is refused.
 */
export function createProjectTaskAgentBindings(options: {
  projects: ProjectTaskAgentProjects;
  credentials: Pick<TaskSessionCredentials, "verify">;
}): (c: Context, ownerScope: OwnerScope) => Promise<ProjectTaskAgentBinding | null> {
  async function terminalBinding(c: Context, ownerScope: OwnerScope): Promise<ProjectTaskAgentBinding> {
    // The local token is shared by every owner terminal; only the gateway-signed credential
    // says which task tab this is. Caller-named panes and ids are never consulted.
    const presented = c.req.header(TASK_SESSION_TOKEN_HEADER);
    if (!presented) throw forbidden();
    let material: Awaited<ReturnType<TaskSessionCredentials["verify"]>>;
    try {
      material = await options.credentials.verify(presented);
    } catch (error: unknown) {
      console.warn("[project-tasks] task session secret unavailable", error instanceof Error ? error.name : "unknown_error");
      throw new ProjectTaskError("board_unavailable");
    }
    if (!material) throw forbidden();
    const sessionRef = `term.${material.workspaceId}.${material.tabId}`;
    if (!TaskSessionRefSchema.safeParse(sessionRef).success) throw forbidden();
    const { id, slug } = project(await options.projects.getProjectById(ownerScope, material.projectId));
    return { ref: sessionRef, projectId: id, projectSlug: slug, readOnly: false };
  }

  return async (c, ownerScope) => {
    if (c.get(LOCAL_TERMINAL_AGENT_CONTEXT_KEY as never) === true) return terminalBinding(c, ownerScope);
    const run = c.get(MATRIX_MCP_RUN_CONTEXT_KEY as never) as MatrixMcpRunContext | undefined;
    if (!run) return null;
    if (!run.board) throw forbidden();
    const { id, slug } = project(await options.projects.getProject(run.board.projectSlug, ownerScope));
    return { ref: run.board.chatId, projectId: id, projectSlug: slug, readOnly: run.board.readOnly };
  };
}

/** The in-process board routes the kernel calls; only reachable from this process. */
export interface ProjectTaskInternalEnv {
  projectTaskAgent: { ownerScope: OwnerScope; binding: ProjectTaskAgentBinding };
}

export type ProjectTaskKernelBindings = (input: {
  owner: { type: string; ownerId: string };
  chatId: string;
  projectSlug?: string;
}) => Promise<ProjectTaskKernelBinding | null>;

/**
 * A kernel chat run's board binding: its project (from the chat's execution root) and
 * the task it was started from (its task session link). The client calls the board
 * routes in process, as `agent:<chat id>`, through the same validation and fences.
 */
export function createProjectTaskKernelBindings(options: {
  routes: Hono;
  projects: Pick<ProjectTaskAgentProjects, "getProject">;
  sessions: Pick<ProjectTaskSessionRepository, "taskForSession"> | null;
}): ProjectTaskKernelBindings {
  return async (input) => {
    if (!input.projectSlug || input.owner.type !== "personal" || !TaskSessionRefSchema.safeParse(input.chatId).success
      || !input.chatId.startsWith("chat_")) return null;
    const ownerScope: OwnerScope = { type: "user", id: input.owner.ownerId };
    const found = await options.projects.getProject(input.projectSlug, ownerScope);
    if (!found.ok) {
      console.warn("[project-tasks] kernel run project unavailable", found.status);
      return null;
    }
    const binding: ProjectTaskAgentBinding = {
      ref: input.chatId, projectId: found.project.id, projectSlug: found.project.slug, readOnly: false,
    };
    const taskId = await options.sessions?.taskForSession(ownerScope.id, binding.projectId, binding.ref) ?? null;
    const env: ProjectTaskInternalEnv = { projectTaskAgent: { ownerScope, binding } };
    const client = createProjectTaskHttpClient({
      baseUrl: "http://project-tasks.internal",
      headers: () => ({}),
      fetch: async (url, init) => options.routes.request(url, init, env),
    });
    return {
      client,
      session: { projectId: binding.projectId, projectSlug: binding.projectSlug, ...(taskId ? { taskId } : {}) },
    };
  };
}

/**
 * Chat adapters are composed before the board routes are registered, so they get this
 * stable function and the board binds it once at registration. Until then no run has
 * board tools.
 */
export function createProjectTaskAgentAccess() {
  let bound: ProjectTaskKernelBindings | null = null;
  return {
    bind(bindings: ProjectTaskKernelBindings): void {
      if (bound) throw new Error("ProjectTaskAgentAccessAlreadyBound");
      bound = bindings;
    },
    kernelBinding: (async (input) => {
      if (!bound) {
        console.warn("[project-tasks] kernel board binding requested before the board was registered");
        return null;
      }
      return bound(input);
    }) satisfies ProjectTaskKernelBindings,
  };
}
