import type { ProjectTask } from "../../../packages/contracts/src/project-tasks.js";

/** A valid wire task for adapter tests. */
export function taskFixture(overrides: Partial<ProjectTask> = {}): ProjectTask {
  return {
    id: "task_42", projectId: "proj_alpha", number: 42, key: "MOS-42", title: "Ship the board",
    description: "", status: "in_progress", priority: "normal", rank: "U", assignee: null, labels: [],
    parentTaskId: null, blockedBy: [], dueAt: null, worktreeId: null, branch: null, pullRequest: null,
    externalLink: null, sessions: [], commentCount: 0, createdBy: "user:owner",
    createdAt: "2026-11-20T10:00:00.000Z", updatedAt: "2026-11-20T10:00:00.000Z", archivedAt: null, revision: 3,
    ...overrides,
  };
}
