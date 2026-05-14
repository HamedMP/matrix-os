import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { PROJECT_SLUG_REGEX } from "../project-manager.js";
import {
  ProjectWorkflowConfigSchema,
  type CodexReadiness,
  type ProjectWorkflowConfig,
} from "./contracts.js";
import { createMemoryWorkflowRepository, type WorkflowRepository } from "./repository.js";

const WORKFLOW_BODY_LIMIT = 64 * 1024;

export interface WorkflowRouteDeps {
  repository?: WorkflowRepository;
  codexReadiness?: (projectSlug: string) => Promise<CodexReadiness>;
}

function emptyWorkflow(projectSlug: string): ProjectWorkflowConfig & {
  projectSlug: string;
  revision: number;
  updatedAt: string | null;
} {
  return {
    projectSlug,
    revision: 0,
    updatedAt: null,
    setupCommands: [],
    liveCommands: [],
    validationCommands: [],
    allowedPreviewPorts: [],
    codexRequired: true,
  };
}

function hasUnsafeCommand(config: ProjectWorkflowConfig): boolean {
  const commands = [...config.setupCommands, ...config.liveCommands, ...config.validationCommands];
  return commands.some((entry) => {
    const command = entry.command.toLowerCase();
    return (
      command.includes("169.254.169.254") ||
      command.includes("metadata.google.internal") ||
      command.includes("curl http://") ||
      command.includes("wget http://")
    );
  });
}

function summarizeWorkflow(record: ProjectWorkflowConfig & { revision: number }) {
  return {
    revision: record.revision,
    setupConfigured: record.setupCommands.length > 0,
    liveConfigured: record.liveCommands.length > 0,
    validationConfigured: record.validationCommands.length > 0,
    allowedPreviewPorts: record.allowedPreviewPorts,
    codexRequired: record.codexRequired,
  };
}

export function createWorkflowRoutes(deps: WorkflowRouteDeps = {}): Hono {
  const app = new Hono();
  const repository = deps.repository ?? createMemoryWorkflowRepository();
  const limited = bodyLimit({ maxSize: WORKFLOW_BODY_LIMIT });

  app.get("/:projectSlug/workflow", async (ctx) => {
    const projectSlug = ctx.req.param("projectSlug");
    if (!PROJECT_SLUG_REGEX.test(projectSlug)) return ctx.json({ error: "Project was not found" }, 404);
    const record = await repository.get(projectSlug) ?? emptyWorkflow(projectSlug);
    const codex = await (deps.codexReadiness?.(projectSlug) ?? Promise.resolve({ status: "unknown" as const }));
    return ctx.json({ workflow: summarizeWorkflow(record), codex });
  });

  app.post("/:projectSlug/workflow", limited, async (ctx) => {
    const projectSlug = ctx.req.param("projectSlug");
    if (!PROJECT_SLUG_REGEX.test(projectSlug)) return ctx.json({ error: "Project was not found" }, 404);

    let raw: unknown;
    try {
      raw = await ctx.req.json();
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "BodyLimitError") {
        return ctx.json({ error: "Workflow configuration is too large" }, 413);
      }
      return ctx.json({ error: "Workflow configuration is invalid" }, 400);
    }

    const parsed = ProjectWorkflowConfigSchema.safeParse(raw);
    if (!parsed.success || hasUnsafeCommand(parsed.data)) {
      return ctx.json({ error: "Workflow configuration is invalid" }, 400);
    }

    const saved = await repository.save(projectSlug, parsed.data);
    const codex = await (deps.codexReadiness?.(projectSlug) ?? Promise.resolve({ status: "unknown" as const }));
    return ctx.json({ workflow: summarizeWorkflow(saved), codex });
  });

  return app;
}
