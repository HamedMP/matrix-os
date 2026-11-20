import {
  createProjectTaskHttpClient, PROJECT_SLUG_PATTERN, ProjectTaskClientError, projectMatchesSession,
  resolveProjectSlug, resolveTaskId, type ProjectDirectory, type ProjectTaskClient,
} from "@matrix-os/contracts/project-task-client";
import {
  ProjectIdSchema, TASK_SESSION_TOKEN_ENV, TASK_SESSION_TOKEN_HEADER, TaskIdSchema, type ProjectTask,
} from "@matrix-os/contracts/project-tasks";
import { requireCliAuthToken } from "./auth-state.js";
import { resolveLocalTerminalConnection } from "./local-terminal-connection.js";
import { cliError, formatCliError, formatCliErrorMessage } from "./output.js";
import { resolveCliProfile } from "./profiles.js";

export interface TaskCliContext {
  client: ProjectTaskClient & ProjectDirectory;
  projectSlug: string;
  /** The task session's own task, set only when the CLI runs inside that session. */
  sessionTaskId?: string;
}

const CLI_MESSAGES: Record<string, string> = {
  project_required: "Name the project with --project <slug>, or run inside a task session.",
  project_out_of_scope: "This task session belongs to another project. Run outside the session to use a different project.",
  task_ref_required: "Name the task: a task_… id or a key such as MOS-42.",
  invalid_session: "This session's MATRIX_PROJECT_ID is not valid.",
  terminal_unbound: "The gateway did not accept this task session's credential. Start the task again from the board, or pass --profile to use your login.",
  invalid_input: "Invalid arguments. Run `matrix tasks --help`.",
  task_agent_working: "An agent of this task is still working. Pass --force to close it anyway.",
};

/**
 * Connection and project for `matrix tasks`. In a task tab the gateway launched, it uses
 * the machine's local token with the tab's signed MATRIX_TASK_SESSION_TOKEN; the gateway
 * then bounds every call to that tab's project and reports that project and task. Any
 * other terminal uses the CLI profile, and a task session's MATRIX_PROJECT_ID keeps the
 * project from being swapped.
 */
export async function resolveTaskCliContext(
  flags: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<TaskCliContext> {
  const requested = typeof flags.project === "string" && flags.project !== "" ? flags.project : undefined;
  const sessionProjectId = env.MATRIX_PROJECT_ID || undefined;
  if (sessionProjectId !== undefined && !ProjectIdSchema.safeParse(sessionProjectId).success) throw cliError("invalid_session");
  if (requested !== undefined && !PROJECT_SLUG_PATTERN.test(requested) && !ProjectIdSchema.safeParse(requested).success) {
    throw cliError("invalid_input");
  }
  const envTaskId = env.MATRIX_TASK_ID && TaskIdSchema.safeParse(env.MATRIX_TASK_ID).success ? env.MATRIX_TASK_ID : undefined;

  const sessionToken = env[TASK_SESSION_TOKEN_ENV];
  // Only a task tab carries a session credential; without one the local token reaches no board.
  const local = sessionToken && sessionToken.length <= 1_024 ? await resolveLocalTerminalConnection(flags, env) : null;
  if (local && sessionToken) {
    const client = createProjectTaskHttpClient({
      baseUrl: local.gatewayUrl,
      headers: () => ({ Authorization: `Bearer ${local.token}`, [TASK_SESSION_TOKEN_HEADER]: sessionToken }),
    });
    const session = await client.getSession().catch((error: unknown) => {
      if (error instanceof ProjectTaskClientError && error.code === "task_forbidden") throw cliError("terminal_unbound");
      throw error;
    });
    if (!session) throw cliError("terminal_unbound");
    if ((sessionProjectId !== undefined && sessionProjectId !== session.projectId)
      || (requested !== undefined && !projectMatchesSession(session, requested))) {
      throw cliError("project_out_of_scope");
    }
    const taskId = session.taskId ?? envTaskId;
    return { client, projectSlug: session.projectSlug, ...(taskId ? { sessionTaskId: taskId } : {}) };
  }

  if (sessionProjectId === undefined && requested === undefined) throw cliError("project_required");
  const profile = await resolveCliProfile(flags);
  const token = await requireCliAuthToken(profile);
  const client = createProjectTaskHttpClient({ baseUrl: profile.gatewayUrl, headers: () => ({ Authorization: `Bearer ${token}` }) });

  if (sessionProjectId !== undefined) {
    const projectSlug = await resolveProjectSlug(client, sessionProjectId);
    if (requested !== undefined && !projectMatchesSession({ projectId: sessionProjectId, projectSlug }, requested)) {
      throw cliError("project_out_of_scope");
    }
    return { client, projectSlug, ...(envTaskId ? { sessionTaskId: envTaskId } : {}) };
  }
  const projectSlug = PROJECT_SLUG_PATTERN.test(requested!) ? requested! : await resolveProjectSlug(client, requested!);
  return { client, projectSlug };
}

export async function resolveTaskArg(context: TaskCliContext, ref: string | undefined): Promise<string> {
  const value = ref ?? context.sessionTaskId;
  if (!value) throw cliError("task_ref_required");
  return resolveTaskId(context.client, context.projectSlug, value);
}

/** Text from the board is untrusted: drop terminal control sequences before printing it. */
export function clean(value: string, multiline = false): string {
  return value
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(multiline ? /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g : /[\u0000-\u001f\u007f-\u009f]/g, "");
}

export function taskLine(task: ProjectTask): string {
  const assignee = task.assignee ? `  @${clean(task.assignee)}` : "";
  return `${clean(task.key)}  ${task.status}  ${task.priority}  ${clean(task.title)}${assignee}`;
}

/** A due date as the board shows it: the calendar day in this machine's time zone. */
function localDate(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function taskDetail(task: ProjectTask): string[] {
  const lines = [`${clean(task.key)}  ${clean(task.title)}`, `status: ${task.status}  priority: ${task.priority}  revision: ${task.revision}`];
  if (task.assignee) lines.push(`assignee: ${clean(task.assignee)}`);
  if (task.labels.length) lines.push(`labels: ${task.labels.map((label) => clean(label)).join(", ")}`);
  if (task.dueAt) lines.push(`due: ${localDate(task.dueAt)}`);
  if (task.parentTaskId) lines.push(`parent: ${clean(task.parentTaskId)}`);
  if (task.blockedBy.length) lines.push(`blocked by: ${task.blockedBy.map((id) => clean(id)).join(", ")}`);
  if (task.commentCount > 0) lines.push(`comments: ${task.commentCount}`);
  if (task.branch) lines.push(`branch: ${clean(task.branch)}`);
  if (task.pullRequest) lines.push(`pull request: #${task.pullRequest.number} ${task.pullRequest.state} ${clean(task.pullRequest.url)}`);
  for (const session of task.sessions) {
    lines.push(`${session.kind}: ${clean(session.title)} (${session.unavailable ? "unavailable" : session.agentStatus})`);
  }
  if (task.description) lines.push("", clean(task.description, true));
  return lines;
}

function errorCode(error: unknown): string {
  if (error instanceof ProjectTaskClientError) return error.code;
  const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
  if (typeof code === "string") return code;
  return "request_failed";
}

function errorMessage(error: unknown, code: string): string {
  if (error instanceof ProjectTaskClientError) {
    if (code === "task_revision_conflict") {
      const revision = error.task ? ` It is now at revision ${error.task.revision}.` : "";
      return `The task changed since it was read.${revision} Run \`matrix tasks get\` to see the change, then retry.`;
    }
    return CLI_MESSAGES[code] ?? error.message;
  }
  if (CLI_MESSAGES[code]) return CLI_MESSAGES[code];
  if (error instanceof Error && code !== "request_failed") return formatCliErrorMessage(code);
  console.warn("[matrix tasks] request failed", error instanceof Error ? error.name : "unknown_error");
  return "Request failed";
}

export function reportTaskCliError(error: unknown, json: boolean): void {
  const code = errorCode(error);
  const message = errorMessage(error, code);
  const details = error instanceof ProjectTaskClientError && error.task ? { currentRevision: error.task.revision } : undefined;
  if (json) console.log(formatCliError(code, message, details));
  else console.error(message);
  process.exitCode = 1;
}
