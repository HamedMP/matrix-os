import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  ProjectIdSchema,
  SafeDisplayStringSchema,
  TerminalRefSchema,
} from "@matrix-os/contracts";
import { TerminalRuntimeError } from "@matrix-os/terminal-runtime";
import { z } from "zod/v4";
import type { RequestPrincipal } from "../request-principal.js";
import { ProjectFenceError } from "../collaboration/project-fence.js";
import {
  terminalResourceOwnerId,
  terminalRuntimeOwnerAccess,
  type TerminalWorkspaceProjectAdmission,
} from "../shell/workspace-routes.js";
import { TERMINAL_REPORT_MAX_CHARS, TerminalCallerSchema, TerminalLabelsSchema, type TerminalAgents } from "./agents.js";
import { MAX_TERMINAL_LABELS, TerminalLabelKeySchema } from "./registry.js";
import type { TerminalTemplates } from "./templates.js";
import { TerminalAgentVerbError, TERMINAL_SEND_TEXT_MAX_CHARS } from "./verbs.js";
import { TERMINAL_WAIT_MAX_MS, TerminalWaitCapacityError } from "./wait.js";

const RunSchema = z.object({
  projectId: ProjectIdSchema.optional(),
  name: SafeDisplayStringSchema,
  cwd: z.string().max(4096),
  argv: z.array(z.string().min(1).max(4096)).min(1).max(128).optional(),
  template: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/).optional(),
  task: z.string().min(1).max(TERMINAL_SEND_TEXT_MAX_CHARS).optional(),
  parent: TerminalRefSchema.optional(),
  caller: TerminalCallerSchema.optional(),
  noParent: z.boolean().optional(),
  outliveParent: z.boolean().optional(),
  labels: TerminalLabelsSchema.optional(),
  readyTimeoutMs: z.number().int().min(1_000).max(60_000).optional(),
}).strict().refine((input) => !(input.argv && input.template), { message: "Use argv or template, not both" });
const LabelSchema = z.object({
  set: TerminalLabelsSchema.optional(),
  remove: z.array(TerminalLabelKeySchema).max(MAX_TERMINAL_LABELS).optional(),
}).strict();
const ReportSchema = z.object({ caller: TerminalCallerSchema, text: z.string().min(1).max(TERMINAL_REPORT_MAX_CHARS) }).strict();
const ResolveSchema = z.object({ caller: TerminalCallerSchema }).strict();
const WaitChildrenSchema = z.object({
  parent: TerminalRefSchema.optional(),
  caller: TerminalCallerSchema.optional(),
  mode: z.enum(["any", "all"]),
  timeoutMs: z.number().int().min(0).max(TERMINAL_WAIT_MAX_MS).optional(),
  cursor: z.string().regex(/^wc_[0-9a-f]{32}$/).optional(),
}).strict().refine((input) => Boolean(input.parent) !== Boolean(input.caller), { message: "Give parent or caller" });

/** Agent orchestration routes under `/api/terminal`: run, labels, reports, children, templates. */
export function createTerminalAgentOrchestrationRoutes(options: {
  agents: TerminalAgents;
  templates: TerminalTemplates;
  getPrincipal: (context: Context) => RequestPrincipal;
  getPreviewTerminalOwner?: (context: Context) => string | undefined;
  terminalOwnerIds: readonly string[];
  projectAdmission: TerminalWorkspaceProjectAdmission;
}): Hono {
  const app = new Hono();
  const mutationLimit = bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: "Request body is too large" }, 413) });
  const ownerGate = async (c: Context, next: () => Promise<void>) => {
    const access = terminalRuntimeOwnerAccess(options.getPrincipal(c), options.terminalOwnerIds, options.getPreviewTerminalOwner?.(c));
    if (access === "unavailable") return c.json({ error: "Terminal operation unavailable" }, 503);
    if (access === "not_found") return c.json({ error: "Terminal operation failed" }, 404);
    await next();
  };
  app.use("/agents/*", ownerGate);
  app.use("/templates", ownerGate);
  app.use("/workspaces/:workspaceId/tabs/:tabId/labels", ownerGate);
  app.use("/workspaces/:workspaceId/tabs/:tabId/agent", ownerGate);
  const ownerId = (c: Context) => terminalResourceOwnerId(options.getPrincipal(c), options.getPreviewTerminalOwner?.(c));

  app.get("/templates", async (c) => {
    try {
      const templates = await options.templates.list();
      return c.json({ templates: templates.map(({ name, description, source }) => ({ name, description, source })) });
    } catch (error) { return failure(c, error); }
  });

  app.post("/agents/run", mutationLimit, async (c) => {
    try {
      const body = RunSchema.parse(await c.req.json());
      return await options.projectAdmission.withProject(ownerId(c), body.projectId, "run", async () => (
        c.json(await options.agents.run(body), 201)
      ));
    } catch (error) { return failure(c, error); }
  });

  app.post("/agents/report", mutationLimit, async (c) => {
    try {
      return c.json(await options.agents.reportToParent(ReportSchema.parse(await c.req.json())));
    } catch (error) { return failure(c, error); }
  });

  app.post("/agents/resolve", mutationLimit, async (c) => {
    try {
      const ref = await options.agents.resolveCaller(ResolveSchema.parse(await c.req.json()).caller);
      if (!ref) return c.json({ error: "Terminal operation failed" }, 404);
      return c.json({ terminalRef: ref });
    } catch (error) { return failure(c, error); }
  });

  app.post("/agents/wait-children", mutationLimit, async (c) => {
    try {
      const body = WaitChildrenSchema.parse(await c.req.json());
      const parent = body.parent ?? await options.agents.resolveCaller(body.caller!);
      if (!parent) return c.json({ error: "Terminal operation failed" }, 404);
      return c.json(await options.agents.waitChildren(parent, {
        mode: body.mode,
        timeoutMs: body.timeoutMs ?? 60_000,
        signal: c.req.raw.signal,
        ...(body.cursor ? { cursor: body.cursor } : {}),
      }));
    } catch (error) { return failure(c, error); }
  });

  app.get("/workspaces/:workspaceId/tabs/:tabId/agent", async (c) => {
    try {
      const record = await options.agents.describe(refFrom(c));
      return c.json({ agent: record ?? null });
    } catch (error) { return failure(c, error); }
  });

  app.patch("/workspaces/:workspaceId/tabs/:tabId/labels", mutationLimit, async (c) => {
    try {
      const ref = refFrom(c);
      const body = LabelSchema.parse(await c.req.json());
      return await options.projectAdmission.withWorkspace(ownerId(c), ref.workspaceId, "write", async () => (
        c.json({ agent: await options.agents.label(ref, body) })
      ));
    } catch (error) { return failure(c, error); }
  });

  return app;
}

function refFrom(c: Context) {
  return TerminalRefSchema.parse({ workspaceId: c.req.param("workspaceId"), tabId: c.req.param("tabId") });
}

function failure(c: Context, error: unknown) {
  if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ error: "Invalid request" }, 400);
  if (error instanceof TerminalWaitCapacityError) return c.json({ error: "terminal_capacity_reached" }, 429);
  if (error instanceof TerminalAgentVerbError) {
    if (error.code === "blocked") return c.json({ error: "terminal_agent_blocked" }, 409);
    if (error.code === "finished") return c.json({ error: "terminal_finished" }, 409);
    if (error.code === "invalid_request") return c.json({ error: "Invalid request" }, 400);
    return c.json({ error: "Terminal operation failed" }, 404);
  }
  console.error("[gateway] terminal agent orchestration failed", error);
  if (error instanceof ProjectFenceError) {
    if (error.code === "invalid") return c.json({ error: "Invalid request" }, 400);
    if (["not_found", "conflict", "fenced", "scope_required"].includes(error.code)) {
      return c.json({ error: "Terminal operation unavailable" }, 409);
    }
    return c.json({ error: "Terminal operation unavailable" }, 503);
  }
  if (error instanceof TerminalRuntimeError) {
    if (error.code === "not_found") return c.json({ error: "Terminal operation failed" }, 404);
    if (error.code === "capacity") return c.json({ error: "terminal_capacity_reached" }, 409);
    if (error.code === "invalid_request") return c.json({ error: "Invalid request" }, 400);
    if (error.code === "unavailable") return c.json({ error: "Terminal operation unavailable" }, 503);
  }
  return c.json({ error: "Terminal operation failed" }, 500);
}
