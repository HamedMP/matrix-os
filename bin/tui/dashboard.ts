interface DashboardProject {
  slug?: string;
  name?: string;
}

interface DashboardPullRequest {
  number?: number;
  title?: string;
  headRef?: string;
  state?: string;
}

interface DashboardWorktree {
  id?: string;
  currentBranch?: string;
  dirtyState?: string;
}

interface DashboardTask {
  id?: string;
  title?: string;
  status?: string;
  priority?: string;
}

interface DashboardSession {
  id?: string;
  status?: string;
  projectSlug?: string;
  taskId?: string;
  nativeAttachCommand?: string[];
}

interface DashboardReview {
  id?: string;
  status?: string;
  projectSlug?: string;
  round?: number;
}

export interface TuiDashboardInput {
  projects: DashboardProject[];
  pullRequests?: DashboardPullRequest[];
  worktrees?: DashboardWorktree[];
  tasks: DashboardTask[];
  sessions: DashboardSession[];
  reviews: DashboardReview[];
}

export interface TuiDashboardSection {
  title: string;
  rows: string[];
}

export interface TuiDashboardModel {
  sections: TuiDashboardSection[];
  actions: string[];
}

export function buildTuiDashboardModel(input: TuiDashboardInput): TuiDashboardModel {
  return {
    sections: [
      {
        title: "Projects",
        rows: input.projects.map((project) => `${project.slug ?? "-"}  ${project.name ?? project.slug ?? "Untitled"}`),
      },
      {
        title: "Pull Requests",
        rows: (input.pullRequests ?? []).map((pr) => `#${pr.number ?? "-"}  ${pr.state ?? "open"}  ${pr.headRef ?? "-"}  ${pr.title ?? ""}`),
      },
      {
        title: "Worktrees",
        rows: (input.worktrees ?? []).map((worktree) => `${worktree.id ?? "-"}  ${worktree.currentBranch ?? "-"}  ${worktree.dirtyState ?? "unknown"}`),
      },
      {
        title: "Tasks",
        rows: input.tasks.map((task) => `${task.id ?? "-"}  ${task.status ?? "todo"}  ${task.priority ?? "normal"}  ${task.title ?? ""}`),
      },
      {
        title: "Sessions",
        rows: input.sessions.map((session) => [
          `${session.id ?? "-"}  ${session.status ?? "unknown"}  ${session.projectSlug ?? "-"}  ${session.taskId ?? "-"}`,
          session.nativeAttachCommand?.join(" "),
        ].filter(Boolean).join("  ")),
      },
      {
        title: "Reviews",
        rows: input.reviews.map((review) => `${review.id ?? "-"}  ${review.status ?? "unknown"}  round:${review.round ?? 0}`),
      },
    ],
    actions: ["attach", "observe", "takeover", "native-terminal", "open-worktree", "review-next"],
  };
}

export function renderTuiDashboard(model: TuiDashboardModel): string {
  return [
    "Matrix OS Workspace",
    "",
    ...model.sections.flatMap((section) => [
      section.title,
      ...section.rows.map((row) => `  ${row}`),
      "",
    ]),
    `Actions: ${model.actions.join(", ")}`,
  ].join("\n");
}
