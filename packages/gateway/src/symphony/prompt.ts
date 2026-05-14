import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PROJECT_SLUG_REGEX } from "../project-manager.js";
import { readJsonFile } from "../state-ops.js";
import type { ProjectConfig } from "../project-manager.js";
import type { TrackedTicket } from "./contracts.js";

export interface WorkflowContract {
  projectSlug: string;
  path: string;
  body: string;
  lastLoadedAt: string;
}

export class SymphonyWorkflowError extends Error {
  constructor(readonly code: "invalid_workflow_path" | "workflow_missing" | "workflow_read_failed") {
    super(code);
    this.name = "SymphonyWorkflowError";
  }
}

const DEFAULT_WORKFLOW = `# Matrix Symphony workflow

You are running as a Matrix-managed coding agent for a claimed Linear ticket.

- Read the ticket context before changing code.
- Keep changes scoped to the requested worktree.
- Follow the repository agent instructions and existing project conventions.
- Run the focused tests for the files you touched before handing off.
- Do not print provider credentials or secrets.
`;

function escapeTemplate(value: string): string {
  return value.replace(/[{}]/g, "");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

async function createDefaultWorkflow(path: string): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  try {
    await writeFile(path, DEFAULT_WORKFLOW, { flag: "wx" });
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EEXIST") return;
    throw err;
  }
}

async function readProject(homePath: string, projectSlug: string): Promise<ProjectConfig | null> {
  if (!PROJECT_SLUG_REGEX.test(projectSlug)) return null;
  try {
    return await readJsonFile<ProjectConfig>(join(homePath, "projects", projectSlug, "config.json"));
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function loadWorkflowContract(input: {
  homePath: string;
  projectSlug: string;
  workflowPath?: string;
  now?: () => string;
}): Promise<WorkflowContract> {
  const project = await readProject(input.homePath, input.projectSlug);
  if (!project) throw new SymphonyWorkflowError("workflow_missing");
  const projectRoot = resolve(project.localPath);
  const hasCustomWorkflowPath = Boolean(input.workflowPath);
  const workflowPath = resolve(hasCustomWorkflowPath ? join(projectRoot, input.workflowPath!) : join(projectRoot, "WORKFLOW.md"));
  if (workflowPath !== projectRoot && !workflowPath.startsWith(`${projectRoot}/`)) {
    throw new SymphonyWorkflowError("invalid_workflow_path");
  }
  if (!await pathExists(workflowPath)) {
    if (hasCustomWorkflowPath) throw new SymphonyWorkflowError("workflow_missing");
    try {
      await createDefaultWorkflow(workflowPath);
    } catch (err: unknown) {
      console.warn("[symphony] Failed to create default workflow:", err instanceof Error ? err.message : String(err));
      throw new SymphonyWorkflowError("workflow_read_failed");
    }
  }
  try {
    const body = (await readFile(workflowPath, "utf8")).trim();
    if (!body) throw new SymphonyWorkflowError("workflow_read_failed");
    return {
      projectSlug: input.projectSlug,
      path: workflowPath,
      body,
      lastLoadedAt: input.now ? input.now() : new Date().toISOString(),
    };
  } catch (err: unknown) {
    if (err instanceof SymphonyWorkflowError) throw err;
    console.warn("[symphony] Workflow read failed:", err instanceof Error ? err.message : String(err));
    throw new SymphonyWorkflowError("workflow_read_failed");
  }
}

export function composeSymphonyPrompt(input: {
  workflow: WorkflowContract;
  ticket: TrackedTicket;
  attempt: number;
}): string {
  const ticket = input.ticket;
  return `${input.workflow.body}

---

Matrix Symphony ticket context:
- Identifier: ${escapeTemplate(ticket.identifier)}
- Title: ${escapeTemplate(ticket.title)}
- URL: ${ticket.url ? escapeTemplate(ticket.url) : "not provided"}
- State: ${escapeTemplate(ticket.stateName)}
- Assignee: ${ticket.assigneeName ? escapeTemplate(ticket.assigneeName) : "unassigned"}
- Labels: ${ticket.labels.map(escapeTemplate).join(", ") || "none"}
- Attempt: ${input.attempt}

Work inside the Matrix-managed project/worktree for this ticket. Keep provider credentials server-side; do not request or print Linear API secrets.`;
}
