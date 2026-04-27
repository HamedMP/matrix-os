interface DashboardProject {
  slug?: string;
  name?: string;
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
}

interface DashboardReview {
  id?: string;
  status?: string;
  projectSlug?: string;
  round?: number;
}

export interface TuiDashboardInput {
  projects: DashboardProject[];
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
        title: "Tasks",
        rows: input.tasks.map((task) => `${task.id ?? "-"}  ${task.status ?? "todo"}  ${task.priority ?? "normal"}  ${task.title ?? ""}`),
      },
      {
        title: "Sessions",
        rows: input.sessions.map((session) => `${session.id ?? "-"}  ${session.status ?? "unknown"}  ${session.projectSlug ?? "-"}  ${session.taskId ?? "-"}`),
      },
      {
        title: "Reviews",
        rows: input.reviews.map((review) => `${review.id ?? "-"}  ${review.status ?? "unknown"}  round:${review.round ?? 0}`),
      },
    ],
    actions: ["attach", "observe", "open-worktree", "review-next"],
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
