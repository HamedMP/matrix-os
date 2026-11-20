import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ProjectTask, ProjectTaskErrorCode } from "@matrix-os/contracts/project-tasks";

const STATUS: Record<ProjectTaskErrorCode, ContentfulStatusCode> = {
  invalid_request: 400,
  project_not_found: 404,
  task_not_found: 404,
  comment_not_found: 404,
  task_revision_conflict: 409,
  task_agent_working: 409,
  task_limit_reached: 409,
  task_relation_invalid: 400,
  task_forbidden: 403,
  board_unavailable: 503,
  board_sync_unavailable: 503,
  task_session_unavailable: 503,
};

const MESSAGE: Record<ProjectTaskErrorCode, string> = {
  invalid_request: "The request is invalid.",
  project_not_found: "Project was not found.",
  task_not_found: "Task was not found.",
  comment_not_found: "Comment was not found.",
  task_revision_conflict: "The task changed since it was loaded.",
  task_agent_working: "An agent is still working on this task.",
  task_limit_reached: "This board has reached its task limit.",
  task_relation_invalid: "That task relation is not allowed.",
  task_forbidden: "You cannot change this.",
  board_unavailable: "The board is unavailable right now.",
  board_sync_unavailable: "Sync is unavailable right now.",
  task_session_unavailable: "The session could not be started right now.",
};

/** Typed board failure; the route mapper turns it into a stable code and generic message. */
export class ProjectTaskError extends Error {
  constructor(readonly code: ProjectTaskErrorCode, readonly task?: ProjectTask) {
    super(code);
    this.name = "ProjectTaskError";
  }

  get status(): ContentfulStatusCode {
    return STATUS[this.code];
  }

  body(): { error: { code: ProjectTaskErrorCode; message: string }; task?: ProjectTask } {
    return { error: { code: this.code, message: MESSAGE[this.code] }, ...(this.task ? { task: this.task } : {}) };
  }
}

export function projectTaskErrorBody(code: ProjectTaskErrorCode) {
  return new ProjectTaskError(code).body();
}
