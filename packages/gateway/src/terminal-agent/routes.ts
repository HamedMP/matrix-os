import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { TerminalRefSchema } from "@matrix-os/contracts";
import { TerminalRuntimeError } from "@matrix-os/terminal-runtime";
import { z } from "zod/v4";
import type { RequestPrincipal } from "../request-principal.js";
import { ProjectFenceError } from "../collaboration/project-fence.js";
import {
  terminalResourceOwnerId,
  terminalRuntimeOwnerAccess,
  type TerminalWorkspaceProjectAdmission,
} from "../shell/workspace-routes.js";
import {
  TERMINAL_KEYS_MAX,
  TERMINAL_READ_LINES_MAX,
  TERMINAL_SEND_TEXT_MAX_CHARS,
  TerminalAgentVerbError,
  type TerminalAgentVerbs,
} from "./verbs.js";

const ReadQuerySchema = z.object({
  lines: z.string().regex(/^\d{1,5}$/).transform(Number).pipe(z.number().int().max(TERMINAL_READ_LINES_MAX)).optional(),
}).strict();
const SendSchema = z.object({
  text: z.string().min(1).max(TERMINAL_SEND_TEXT_MAX_CHARS),
  force: z.boolean().optional(),
  maxHoldMs: z.number().int().min(0).max(60_000).optional(),
}).strict();
const KeysSchema = z.object({ keys: z.array(z.string().min(1).max(16)).min(1).max(TERMINAL_KEYS_MAX) }).strict();
const InterruptSchema = z.object({}).strict();

/**
 * Herdr-style agent verbs on canonical terminal tabs, mounted under `/api/terminal`.
 * Same owner gate as the workspace routes; mutating verbs run inside project admission.
 */
export function createTerminalAgentRoutes(options: {
  verbs: TerminalAgentVerbs;
  getPrincipal: (context: Context) => RequestPrincipal;
  getPreviewTerminalOwner?: (context: Context) => string | undefined;
  terminalOwnerIds: readonly string[];
  projectAdmission: TerminalWorkspaceProjectAdmission;
}): Hono {
  const app = new Hono();
  const mutationLimit = bodyLimit({
    maxSize: 16 * 1024,
    onError: (c) => c.json({ error: "Request body is too large" }, 413),
  });

  app.use("/workspaces/:workspaceId/tabs/:tabId/*", ownerGate);
  app.use("/workspaces/:workspaceId/tabs/:tabId", ownerGate);

  async function ownerGate(c: Context, next: () => Promise<void>) {
    const access = terminalRuntimeOwnerAccess(
      options.getPrincipal(c),
      options.terminalOwnerIds,
      options.getPreviewTerminalOwner?.(c),
    );
    if (access === "unavailable") return c.json({ error: "Terminal operation unavailable" }, 503);
    if (access === "not_found") return c.json({ error: "Terminal operation failed" }, 404);
    await next();
  }

  const run = <T>(c: Context, workspaceId: string, operation: () => Promise<T>) => {
    const principal = options.getPrincipal(c);
    return options.projectAdmission.withWorkspace(
      terminalResourceOwnerId(principal, options.getPreviewTerminalOwner?.(c)),
      workspaceId,
      "run",
      operation,
    );
  };

  app.get("/workspaces/:workspaceId/tabs/:tabId", async (c) => {
    try {
      const ref = refFrom(c);
      return c.json(await options.verbs.get(ref));
    } catch (error) { return failure(c, error); }
  });

  app.get("/workspaces/:workspaceId/tabs/:tabId/read", async (c) => {
    try {
      const ref = refFrom(c);
      const query = ReadQuerySchema.parse(Object.fromEntries(new URL(c.req.url).searchParams.entries()));
      return c.json(await options.verbs.read(ref, { lines: query.lines ?? 0 }));
    } catch (error) { return failure(c, error); }
  });

  app.post("/workspaces/:workspaceId/tabs/:tabId/send", mutationLimit, async (c) => {
    try {
      const ref = refFrom(c);
      const body = SendSchema.parse(await c.req.json());
      // A send held for a draft is dropped if the caller disconnects, never typed later.
      return await run(c, ref.workspaceId, async () => c.json(await options.verbs.send(ref, { ...body, signal: c.req.raw.signal })));
    } catch (error) { return failure(c, error); }
  });

  app.post("/workspaces/:workspaceId/tabs/:tabId/keys", mutationLimit, async (c) => {
    try {
      const ref = refFrom(c);
      const body = KeysSchema.parse(await c.req.json());
      return await run(c, ref.workspaceId, async () => c.json(await options.verbs.keys(ref, body)));
    } catch (error) { return failure(c, error); }
  });

  app.post("/workspaces/:workspaceId/tabs/:tabId/interrupt", mutationLimit, async (c) => {
    try {
      const ref = refFrom(c);
      InterruptSchema.parse(await readOptionalJson(c));
      return await run(c, ref.workspaceId, async () => c.json(await options.verbs.interrupt(ref, { signal: c.req.raw.signal })));
    } catch (error) { return failure(c, error); }
  });

  return app;
}

function refFrom(c: Context) {
  return TerminalRefSchema.parse({ workspaceId: c.req.param("workspaceId"), tabId: c.req.param("tabId") });
}

async function readOptionalJson(c: Context): Promise<unknown> {
  const text = await c.req.text();
  return text.trim() === "" ? {} : JSON.parse(text);
}

function failure(c: Context, error: unknown) {
  if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ error: "Invalid request" }, 400);
  if (error instanceof TerminalAgentVerbError) {
    if (error.code === "blocked") return c.json({ error: "terminal_agent_blocked" }, 409);
    if (error.code === "finished") return c.json({ error: "terminal_finished" }, 409);
    if (error.code === "cancelled") return c.json({ error: "terminal_send_cancelled" }, 409);
    if (error.code === "invalid_request") return c.json({ error: "Invalid request" }, 400);
    return c.json({ error: "Terminal operation failed" }, 404);
  }
  console.error("[gateway] terminal agent verb failed", error);
  if (error instanceof ProjectFenceError) {
    if (error.code === "invalid") return c.json({ error: "Invalid request" }, 400);
    if (["not_found", "conflict", "fenced", "scope_required"].includes(error.code)) {
      return c.json({ error: "Terminal operation unavailable" }, 409);
    }
    return c.json({ error: "Terminal operation unavailable" }, 503);
  }
  if (error instanceof TerminalRuntimeError) {
    if (error.code === "not_found") return c.json({ error: "Terminal operation failed" }, 404);
    if (error.code === "invalid_request") return c.json({ error: "Invalid request" }, 400);
    if (error.code === "unavailable") return c.json({ error: "Terminal operation unavailable" }, 503);
  }
  return c.json({ error: "Terminal operation failed" }, 500);
}
