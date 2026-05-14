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
  const privateTarget = /(169\.254\.169\.254|metadata\.google\.internal|(?:^|[^\d])10\.\d+\.\d+\.\d+|(?:^|[^\d])192\.168\.\d+\.\d+|(?:^|[^\d])172\.(?:1[6-9]|2\d|3[0-1])\.\d+\.\d+)/i;
  return commands.some((entry) => {
    const command = entry.command.toLowerCase();
    return (
      privateTarget.test(command) ||
      /\b(?:curl|wget|nc)\b[^\n]*(?:http:\/\/)?(?:10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[0-1])\.\d+\.\d+)/i.test(command)
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
      console.warn("[workflow] Failed to parse workflow request body:", err);
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
