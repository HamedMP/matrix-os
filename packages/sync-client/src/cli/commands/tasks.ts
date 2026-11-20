import { defineCommand } from "citty";
import { newTaskClientRequestId } from "@matrix-os/contracts/project-task-client";
import {
  TASK_PRIORITIES, TASK_STATUSES, TaskStatusSchema, type ProjectTask, type TaskPriority, type TaskStatus,
} from "@matrix-os/contracts/project-tasks";
import { cliError, formatCliSuccess } from "../output.js";
import {
  clean, reportTaskCliError, resolveTaskArg, resolveTaskCliContext, taskDetail, taskLine, type TaskCliContext,
} from "../project-task-cli.js";

const connectionArgs = {
  profile: { type: "string", required: false, description: "CLI profile" },
  dev: { type: "boolean", required: false, default: false },
  gateway: { type: "string", required: false },
  token: { type: "string", required: false },
  json: { type: "boolean", required: false, default: false, description: "Machine-readable output" },
  project: { type: "string", required: false, description: "Project slug; defaults to the task session's project" },
} as const;

type Args = Record<string, unknown>;

function text(args: Args, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** A flag's value even when it is explicitly empty (`--description ""`); undefined only when absent. */
function given(args: Args, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" ? value : undefined;
}

function oneOf<T extends string>(values: readonly T[], value: string | undefined): T | undefined {
  if (value === undefined) return undefined;
  if (!(values as readonly string[]).includes(value)) throw cliError("invalid_input");
  return value as T;
}

function labels(args: Args): string[] | undefined {
  const value = text(args, "label");
  return value === undefined ? undefined : value.split(",").map((label) => label.trim()).filter(Boolean);
}

/** One handler shape for every verb: resolve the session, run, print. */
function verb(
  name: string,
  description: string,
  args: Record<string, unknown>,
  action: (context: TaskCliContext, args: Args) => Promise<{ data: Record<string, unknown>; human: string[] }>,
) {
  return defineCommand({
    meta: { name, description },
    args: { ...connectionArgs, ...args } as typeof connectionArgs,
    async run({ args: input }) {
      const parsed = input as Args;
      const json = parsed.json === true;
      try {
        const context = await resolveTaskCliContext(parsed);
        const result = await action(context, parsed);
        if (json) console.log(formatCliSuccess(result.data));
        else for (const line of result.human) console.log(line);
      } catch (error: unknown) {
        reportTaskCliError(error, json);
      }
    },
  });
}

const first = { type: "positional", required: false } as const;
const second = { type: "positional", required: false } as const;

function moved(task: ProjectTask) {
  return { data: { task }, human: [`${clean(task.key)} → ${task.status}`] };
}

export const tasksCommand = defineCommand({
  meta: {
    name: "tasks",
    description: "Project board tasks. Inside a task session the project and task default to the session's own (MATRIX_PROJECT_ID, MATRIX_TASK_ID).",
  },
  subCommands: {
    list: verb("list", "List tasks: matrix tasks list [--status todo] [--q text]", {
      status: { type: "string", required: false }, assignee: { type: "string", required: false },
      label: { type: "string", required: false }, q: { type: "string", required: false },
      limit: { type: "string", required: false }, cursor: { type: "string", required: false },
      archived: { type: "boolean", required: false, default: false },
    }, async ({ client, projectSlug }, args) => {
      const result = await client.listTasks(projectSlug, {
        ...(text(args, "status") ? { status: oneOf(TASK_STATUSES, text(args, "status")) } : {}),
        ...(text(args, "assignee") ? { assignee: text(args, "assignee") as "unassigned" } : {}),
        ...(text(args, "label") ? { label: text(args, "label") } : {}),
        ...(text(args, "q") ? { q: text(args, "q") } : {}),
        ...(text(args, "cursor") ? { cursor: text(args, "cursor") } : {}),
        ...(text(args, "limit") ? { limit: Number(text(args, "limit")) } : {}),
        ...(args.archived === true ? { includeArchived: "true" as const } : {}),
      });
      const human = result.tasks.length ? result.tasks.map(taskLine) : ["No tasks."];
      if (result.nextCursor) human.push(`More: --cursor ${result.nextCursor}`);
      return { data: { tasks: result.tasks, nextCursor: result.nextCursor }, human };
    }),
    get: verb("get", "Show a task: matrix tasks get [task] [--comments | --activity] [--cursor <next page>]", {
      first, comments: { type: "boolean", required: false, default: false },
      activity: { type: "boolean", required: false, default: false },
      cursor: { type: "string", required: false, description: "Continue --comments or --activity from where the last page ended" },
    }, async (context, args) => {
      const cursor = text(args, "cursor");
      const wantComments = args.comments === true;
      const wantActivity = args.activity === true;
      // A cursor belongs to one history: comments and activity page independently.
      if (cursor !== undefined && wantComments === wantActivity) throw cliError("invalid_input");
      const task = await context.client.getTask(context.projectSlug, await resolveTaskArg(context, text(args, "first")));
      const page = cursor !== undefined ? { cursor } : {};
      const data: Record<string, unknown> = { task };
      const human = taskDetail(task);
      if (wantComments) {
        const result = await context.client.listComments(context.projectSlug, task.id, page);
        Object.assign(data, { comments: result.comments, commentsNextCursor: result.nextCursor });
        human.push("", ...result.comments.map((comment) => `${clean(comment.author)}: ${clean(comment.body, true)}`));
        if (result.nextCursor) human.push(`More comments: --comments --cursor ${clean(result.nextCursor)}`);
      }
      if (wantActivity) {
        const result = await context.client.listActivity(context.projectSlug, task.id, page);
        Object.assign(data, { activity: result.activity, activityNextCursor: result.nextCursor });
        human.push("", ...result.activity.map((entry) => `${entry.at}  ${clean(entry.actor)}  ${clean(entry.summary)}`));
        if (result.nextCursor) human.push(`More activity: --activity --cursor ${clean(result.nextCursor)}`);
      }
      return { data, human };
    }),
    create: verb("create", "Create a task: matrix tasks create \"title\" [--description] [--status] [--priority] [--label a,b] [--parent task]", {
      first, description: { type: "string", required: false }, status: { type: "string", required: false },
      priority: { type: "string", required: false }, label: { type: "string", required: false },
      parent: { type: "string", required: false }, due: { type: "string", required: false },
      "request-id": { type: "string", required: false, description: "Reuse to retry a create without a duplicate" },
    }, async (context, args) => {
      const title = text(args, "first");
      if (!title) throw cliError("invalid_input");
      const parent = text(args, "parent");
      const task = await context.client.createTask(context.projectSlug, {
        title,
        clientRequestId: text(args, "request-id") ?? newTaskClientRequestId(),
        ...(given(args, "description") !== undefined ? { description: given(args, "description") } : {}),
        ...(text(args, "status") ? { status: oneOf<TaskStatus>(TASK_STATUSES, text(args, "status")) } : {}),
        ...(text(args, "priority") ? { priority: oneOf<TaskPriority>(TASK_PRIORITIES, text(args, "priority")) } : {}),
        ...(labels(args) ? { labels: labels(args) } : {}),
        ...(parent ? { parentTaskId: await resolveTaskArg(context, parent) } : {}),
        ...(text(args, "due") ? { dueAt: text(args, "due") } : {}),
      });
      return { data: { task }, human: [`Created ${clean(task.key)}  ${clean(task.title)}`] };
    }),
    update: verb("update", "Change a task: matrix tasks update [task] [--title] [--description (\"\" clears)] [--priority] [--label a,b] [--assignee]", {
      first, title: { type: "string", required: false }, description: { type: "string", required: false },
      priority: { type: "string", required: false }, label: { type: "string", required: false },
      assignee: { type: "string", required: false }, due: { type: "string", required: false },
    }, async (context, args) => {
      const taskId = await resolveTaskArg(context, text(args, "first"));
      const current = await context.client.getTask(context.projectSlug, taskId);
      const assignee = text(args, "assignee");
      const task = await context.client.updateTask(context.projectSlug, taskId, {
        baseRevision: current.revision,
        ...(text(args, "title") ? { title: text(args, "title") } : {}),
        // An explicitly empty value clears the description; an absent flag leaves it unchanged.
        ...(given(args, "description") !== undefined ? { description: given(args, "description") } : {}),
        ...(text(args, "priority") ? { priority: oneOf<TaskPriority>(TASK_PRIORITIES, text(args, "priority")) } : {}),
        ...(labels(args) ? { labels: labels(args) } : {}),
        ...(assignee ? { assignee: assignee === "none" ? null : assignee as `user:${string}` } : {}),
        ...(text(args, "due") ? { dueAt: text(args, "due") === "none" ? null : text(args, "due") } : {}),
      });
      return { data: { task }, human: [`Updated ${clean(task.key)} (revision ${task.revision})`] };
    }),
    move: verb("move", "Move a task: matrix tasks move [task] <status> [--force]", {
      first, second, force: { type: "boolean", required: false, default: false },
    }, async (context, args) => {
      const values = [text(args, "first"), text(args, "second")].filter((value): value is string => value !== undefined);
      const status = values.find((value) => TaskStatusSchema.safeParse(value).success) as TaskStatus | undefined;
      const ref = values.find((value) => value !== status);
      if (!status) throw cliError("invalid_input");
      const taskId = await resolveTaskArg(context, ref);
      return moved(await context.client.moveTask(context.projectSlug, taskId, { status, ...(args.force === true ? { force: true } : {}) }));
    }),
    done: verb("done", "Mark a task done; refused while its agent works unless --force", {
      first, force: { type: "boolean", required: false, default: false },
    }, async (context, args) => {
      const taskId = await resolveTaskArg(context, text(args, "first"));
      return moved(await context.client.moveTask(context.projectSlug, taskId, { status: "done", ...(args.force === true ? { force: true } : {}) }));
    }),
    comment: verb("comment", "Comment on a task: matrix tasks comment [task] \"text\"", { first, second }, async (context, args) => {
      const body = text(args, "second") ?? text(args, "first");
      const ref = text(args, "second") !== undefined ? text(args, "first") : undefined;
      if (!body) throw cliError("invalid_input");
      const comment = await context.client.createComment(context.projectSlug, await resolveTaskArg(context, ref), { body });
      return { data: { comment }, human: ["Comment added."] };
    }),
    start: verb("start", "Start work: matrix tasks start [task] [--kind chat|terminal] [--harness codex] [--worktree new|existing|none] [--message]", {
      first, kind: { type: "string", required: false, default: "chat" }, harness: { type: "string", required: false },
      worktree: { type: "string", required: false }, message: { type: "string", required: false },
    }, async (context, args) => {
      const taskId = await resolveTaskArg(context, text(args, "first"));
      const result = await context.client.startTask(context.projectSlug, taskId, {
        kind: oneOf(["chat", "terminal"] as const, text(args, "kind") ?? "chat")!,
        ...(text(args, "harness") ? { harness: text(args, "harness") } : {}),
        ...(text(args, "worktree") ? { worktree: oneOf(["new", "existing", "none"] as const, text(args, "worktree")) } : {}),
        ...(text(args, "message") ? { message: text(args, "message") } : {}),
      });
      const opened = `${result.session.kind} ${clean(result.session.title)} for ${clean(result.task.key)}`;
      if (result.firstMessage === undefined) {
        return { data: { task: result.task, session: result.session, agentStarted: true }, human: [`Started ${opened}`] };
      }
      // Without a model selection the gateway opens the session but sends nothing: say so and hand over the message.
      const where = result.session.kind === "chat"
        ? "Open the chat from the task on the board and send this first message:"
        : "Send this first message to the agent in the terminal tab:";
      return {
        data: { task: result.task, session: result.session, firstMessage: result.firstMessage, agentStarted: false },
        human: [`Opened ${opened}. No agent turn was started.`, where, "", clean(result.firstMessage, true)],
      };
    }),
    open: verb("open", "Show a task's key and title", { first }, async (context, args) => {
      const task = await context.client.getTask(context.projectSlug, await resolveTaskArg(context, text(args, "first")));
      return { data: { id: task.id, key: task.key, title: task.title }, human: [`${clean(task.key)}  ${clean(task.title)}`] };
    }),
  },
});
