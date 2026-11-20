import type { ActorRef, BoardMember, ProjectTask, TaskActivity, TaskComment, TaskSession } from "./types.js";

/** Test seed data: invented people and work, chosen to exercise every card state. */

export const FIXTURE_PROJECT_ID = "proj_prototype";
export const FIXTURE_TASK_KEY = "MOS";
export const FIXTURE_OWNER: ActorRef = "user:owner";

export const FIXTURE_MEMBERS: readonly BoardMember[] = [
  { actor: FIXTURE_OWNER, name: "You", handle: "you" },
  { actor: "user:ana", name: "Ana Ruiz", handle: "ana" },
  { actor: "user:yuki", name: "Yuki Tanaka", handle: "yuki" },
  { actor: "user:sam", name: "Sam Okafor", handle: "sam" },
];

export const FIXTURE_AGENT: ActorRef = "agent:chat_fixture_agent";

interface SeedTask {
  number: number;
  title: string;
  status: ProjectTask["status"];
  priority?: ProjectTask["priority"];
  assignee?: ActorRef | null;
  labels?: string[];
  parent?: number;
  blockedBy?: number[];
  dueInDays?: number;
  branch?: boolean;
  pullRequest?: Omit<NonNullable<ProjectTask["pullRequest"]>, "url">;
  linear?: string;
  sessions?: Array<Pick<TaskSession, "kind" | "agentStatus" | "harness" | "title">>;
  description?: string;
  archived?: boolean;
  createdBy?: ActorRef;
  ageHours: number;
}

const SEED: readonly SeedTask[] = [
  { number: 12, title: "Dark mode for the task detail sheet", status: "backlog", priority: "low", labels: ["design"], ageHours: 300 },
  { number: 15, title: "Investigate flaky terminal reconnect after the laptop sleeps on Safari while the gateway restarts mid-session and the tab is hidden", status: "backlog", priority: "normal", labels: ["bug", "terminal"], ageHours: 260 },
  { number: 18, title: "Import labels from Linear", status: "backlog", labels: ["linear", "sync"], linear: "ENG-512", ageHours: 200 },
  { number: 21, title: "Keyboard shortcut cheat sheet", status: "backlog", priority: "low", assignee: "user:yuki", labels: ["docs", "ux"], ageHours: 180 },
  { number: 23, title: "Clean up worktree action for closed tasks", status: "todo", priority: "normal", assignee: "user:sam", labels: ["git"], blockedBy: [31], ageHours: 150 },
  { number: 24, title: "Remember board filters per surface", status: "todo", priority: "high", assignee: FIXTURE_OWNER, labels: ["board", "ux"], branch: true,
    sessions: [{ kind: "terminal", agentStatus: "idle", harness: "Shell", title: "Terminal" }], ageHours: 120 },
  { number: 26, title: "Billing page shows the wrong renewal date", status: "todo", priority: "urgent", assignee: "user:ana", labels: ["bug", "billing"], linear: "ENG-498", dueInDays: 1, ageHours: 30,
    description: "Customers on annual plans see the trial end date instead of the renewal date.\n\n**Repro**\n1. Open Settings → Billing on an annual plan\n2. Compare *Renews on* with the Stripe invoice" },
  { number: 27, title: "Import existing task JSON files on first boot", status: "todo", priority: "normal", labels: ["migration"], parent: 30, ageHours: 100 },
  { number: 30, title: "Move project tasks to owner Postgres", status: "in_progress", priority: "high", assignee: FIXTURE_OWNER,
    labels: ["backend", "database", "migration", "board", "gateway", "kysely"], branch: true, dueInDays: 5,
    sessions: [
      { kind: "chat", agentStatus: "working", harness: "Claude Code", title: "Schema and migrations" },
      { kind: "terminal", agentStatus: "idle", harness: "Codex", title: "Codex · tests" },
    ],
    description: "Replace the JSON task store with Kysely tables in the owner's Postgres.\n\n- Versioned migrations and advisory lock\n- `ON CONFLICT` import from `~/system/projects/<slug>/tasks/`\n- Activity row in the same transaction as every write",
    ageHours: 90 },
  { number: 32, title: "Mobile list grouped by status", status: "in_progress", priority: "normal", assignee: "user:yuki", labels: ["mobile"], branch: true,
    sessions: [{ kind: "chat", agentStatus: "blocked", harness: "Codex", title: "Mobile list" }], ageHours: 70 },
  { number: 33, title: "Paginate the activity log", status: "in_progress", priority: "low", assignee: FIXTURE_AGENT, labels: ["backend"], parent: 30, branch: true,
    sessions: [{ kind: "chat", agentStatus: "working", harness: "Pi", title: "Activity paging" }], createdBy: FIXTURE_AGENT, ageHours: 20 },
  { number: 34, title: "Linear status mapping overrides", status: "in_progress", priority: "normal", assignee: "user:ana", labels: ["linear"], linear: "ENG-505", branch: true,
    pullRequest: { number: 3481, state: "draft", checks: "pending", review: "none" },
    sessions: [{ kind: "chat", agentStatus: "done", harness: "Claude Code", title: "Status mapping" }], ageHours: 50 },
  { number: 31, title: "PR checks roll-up on cards", status: "in_review", priority: "high", assignee: "user:sam", labels: ["board", "git"], branch: true,
    pullRequest: { number: 3474, state: "open", checks: "passing", review: "approved" },
    sessions: [{ kind: "chat", agentStatus: "done", harness: "Codex", title: "Checks roll-up" }], ageHours: 80 },
  { number: 35, title: "Assignment notifications through the router", status: "in_review", priority: "urgent", assignee: FIXTURE_OWNER, labels: ["notifications"], branch: true,
    pullRequest: { number: 3477, state: "open", checks: "failing", review: "changes_requested" },
    sessions: [{ kind: "terminal", agentStatus: "error", harness: "Claude Code", title: "Claude · notify" }], ageHours: 60 },
  { number: 36, title: "Drag and drop between columns", status: "in_review", priority: "normal", assignee: "user:yuki", labels: ["board", "ux"], linear: "ENG-509", branch: true,
    pullRequest: { number: 3479, state: "open", checks: "pending", review: "review_required" }, ageHours: 40 },
  { number: 28, title: "Board settings: task key prefix", status: "done", priority: "normal", assignee: "user:sam", labels: ["board"], branch: true,
    pullRequest: { number: 3460, state: "merged", checks: "passing", review: "approved" }, ageHours: 240 },
  { number: 29, title: "Fractional ranks for card order", status: "done", priority: "high", assignee: FIXTURE_OWNER, labels: ["board"], branch: true,
    pullRequest: { number: 3462, state: "merged", checks: "passing", review: "approved" },
    sessions: [{ kind: "chat", agentStatus: "done", harness: "Claude Code", title: "Ranks" }], ageHours: 220 },
  { number: 25, title: "Write the board spec", status: "done", assignee: "user:ana", labels: ["docs"], ageHours: 320 },
  { number: 19, title: "Custom board columns", status: "canceled", priority: "low", labels: ["board"], ageHours: 400 },
  { number: 11, title: "First task list prototype", status: "done", labels: ["board"], archived: true, ageHours: 600 },
];

const SEED_COMMENTS: ReadonlyArray<{ task: number; author: ActorRef; body: string; ageHours: number }> = [
  { task: 30, author: "user:ana", body: "Should the import also carry over `linkedWorktreeId`?", ageHours: 40 },
  { task: 30, author: FIXTURE_OWNER, body: "Yes, both linked ids carry over. @ana can you review the mapping table?", ageHours: 38 },
  { task: 30, author: FIXTURE_AGENT, body: "Migrations 001–003 are in. Running the PGlite suite next.", ageHours: 2 },
  { task: 31, author: "user:sam", body: "Checks come from `gh pr view --json statusCheckRollup`.", ageHours: 30 },
  { task: 31, author: "user:yuki", body: "Can the badge show pending as well?", ageHours: 26 },
  { task: 31, author: "user:sam", body: "Added a pending state.", ageHours: 24 },
  { task: 31, author: FIXTURE_OWNER, body: "Looks good, approving.", ageHours: 4 },
  { task: 35, author: "user:ana", body: "The dedupe key needs the actor, otherwise reassigning back is swallowed.", ageHours: 10 },
  { task: 35, author: FIXTURE_OWNER, body: "Good catch — fixing.", ageHours: 9 },
  { task: 26, author: "user:ana", body: "Mirrored from Linear. Two customers reported it today.", ageHours: 28 },
];

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function taskBranchName(keyPrefix: string, number: number, title: string): string {
  return `task/${keyPrefix.toLowerCase()}-${number}-${slug(title)}`.slice(0, 60).replace(/-$/, "");
}

export interface FixtureSeed {
  tasks: ProjectTask[];
  comments: TaskComment[];
  activity: TaskActivity[];
}

/** Ranks per column: evenly spaced base-62 digits, so seed order is the array order. */
const SEED_RANK_DIGITS = "123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export function buildFixtureSeed(nowMs: number): FixtureSeed {
  const at = (hours: number) => new Date(nowMs - hours * 3_600_000).toISOString();
  const id = (number: number) => `task_fixture_${number}`;
  const perColumn: Record<string, number> = {};
  const tasks = SEED.map((seed): ProjectTask => {
    const position = perColumn[seed.status] = (perColumn[seed.status] ?? -1) + 1;
    const branch = seed.branch ? taskBranchName(FIXTURE_TASK_KEY, seed.number, seed.title) : null;
    return {
      id: id(seed.number), projectId: FIXTURE_PROJECT_ID, number: seed.number, key: `${FIXTURE_TASK_KEY}-${seed.number}`, title: seed.title, description: seed.description ?? "",
      status: seed.status, priority: seed.priority ?? "none", rank: `${SEED_RANK_DIGITS[position * 2]}V`,
      assignee: seed.assignee ?? null, labels: seed.labels ?? [], parentTaskId: seed.parent ? id(seed.parent) : null,
      blockedBy: (seed.blockedBy ?? []).map(id), dueAt: seed.dueInDays === undefined ? null : at(-24 * seed.dueInDays),
      worktreeId: null, branch, externalLink: seed.linear ? { provider: "linear", key: seed.linear, url: `https://linear.app/example/issue/${seed.linear}` } : null,
      pullRequest: seed.pullRequest ? { ...seed.pullRequest, url: `https://github.com/example/project/pull/${seed.pullRequest.number}` } : null,
      sessions: (seed.sessions ?? []).map((session, index) => ({
        ...session, role: index === 0 ? "main" : "extra",
        ref: session.kind === "chat" ? `chat_fixture_${seed.number}_${index}` : `term.tws_fixture.tt_${seed.number}_${index}`,
      })),
      commentCount: SEED_COMMENTS.filter((comment) => comment.task === seed.number).length,
      createdBy: seed.createdBy ?? FIXTURE_OWNER, createdAt: at(seed.ageHours), updatedAt: at(Math.max(1, seed.ageHours / 6)),
      archivedAt: seed.archived ? at(seed.ageHours / 2) : null, revision: 1,
    };
  });
  const comments = SEED_COMMENTS.map((comment, index): TaskComment => ({
    id: `tcm_fixture_${index}`, taskId: id(comment.task), author: comment.author, body: comment.body, createdAt: at(comment.ageHours), editedAt: null,
  }));
  let seq = 0;
  const activity: TaskActivity[] = [];
  for (const seed of SEED) {
    activity.push({ seq: ++seq, taskId: id(seed.number), actor: seed.createdBy ?? FIXTURE_OWNER, kind: "created", summary: "Created the task", at: at(seed.ageHours) });
    if (seed.sessions?.length) {
      activity.push({ seq: ++seq, taskId: id(seed.number), actor: seed.assignee ?? FIXTURE_OWNER, kind: "session_started", summary: `Started ${seed.sessions[0]!.title}`, at: at(seed.ageHours * 0.8) });
    }
    if (seed.pullRequest) {
      activity.push({ seq: ++seq, taskId: id(seed.number), actor: "system:automation", kind: "pr_opened", summary: `Opened pull request #${seed.pullRequest.number}`, at: at(seed.ageHours * 0.5) });
    }
    if (seed.pullRequest?.state === "merged") {
      activity.push({ seq: ++seq, taskId: id(seed.number), actor: "system:automation", kind: "pr_merged", summary: "In review → Done", at: at(seed.ageHours * 0.3) });
    }
  }
  return { tasks, comments, activity };
}
