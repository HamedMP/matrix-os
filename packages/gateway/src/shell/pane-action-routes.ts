import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { z } from "zod/v4";
import { CanonicalChatIdSchema, TerminalPaneActionSchema } from "@matrix-os/contracts";
import { SESSION_NAME_PATTERN } from "./names.js";
import { shellError, toShellError } from "./errors.js";
import type { ShellRouteDeps } from "./routes.js";

const NameSchema = z.string().regex(SESSION_NAME_PATTERN);
const QuerySchema = z.object({ chatId: CanonicalChatIdSchema.optional() }).strict();

/** Mounted below the gateway's authenticated Terminal routes. */
export function registerTerminalPaneActionRoutes(app: Hono, deps: ShellRouteDeps): void {
  app.post("/sessions/:name/pane-actions", bodyLimit({
    maxSize: 1024,
    onError: (c) => c.json({ error: { code: "payload_too_large", message: "Request too large" } }, 413),
  }), async (c) => {
    try {
      const requestedName = NameSchema.parse(c.req.param("name"));
      const query = QuerySchema.parse(Object.fromEntries(new URL(c.req.url).searchParams.entries()));
      const action = TerminalPaneActionSchema.parse(await c.req.json());
      if (query.chatId !== undefined) {
        if (!deps.getPrincipal || !deps.chatPaneAction) {
          throw shellError("pane_actions_unavailable", "Request failed", 503);
        }
        // Chat owns its registry and adapter: workspace terminals must never be
        // looked up through, or adopted into, the standalone Terminal registry.
        await deps.chatPaneAction(deps.getPrincipal(c), {
          chatId: query.chatId, sessionId: requestedName, action,
        });
        return c.json({ ok: true });
      }
      if (!deps.workspace?.paneAction) {
        throw shellError("pane_actions_unavailable", "Request failed", 503);
      }
      const session = deps.registry.get
        ? await deps.registry.get(requestedName)
        : (await deps.registry.list()).find((entry) => (
          entry != null && typeof entry === "object" && "name" in entry && entry.name === requestedName
        ));
      if (!session || typeof session !== "object" || !("name" in session)
        || ("status" in session && session.status !== "active")) {
        throw shellError("session_not_found", "Session not found", 404);
      }
      if ("sharedControlMode" in session && session.sharedControlMode === "shared") {
        return c.json({
          error: { code: "terminal_shared", message: "Use the shared terminal route" },
        }, 409);
      }
      // Registry reads reconcile renames and verify the currently running generation.
      const name = NameSchema.parse(session.name);
      if (deps.listChatBoundSessionIds) {
        if (!deps.getPrincipal) throw shellError("pane_actions_unavailable", "Request failed", 503);
        const bound = await deps.listChatBoundSessionIds(deps.getPrincipal(c), [name]);
        if (bound.includes(name)) throw shellError("session_not_found", "Session not found", 404);
      }
      await deps.workspace.paneAction(name, action);
      return c.json({ ok: true });
    } catch (err: unknown) {
      if ((err instanceof HTTPException && err.status === 413)
        || (err instanceof Error && err.name === "BodyLimitError")) {
        return c.json({ error: { code: "payload_too_large", message: "Request too large" } }, 413);
      }
      if (err instanceof z.ZodError || err instanceof SyntaxError) {
        return c.json({ error: { code: "invalid_request", message: "Invalid request" } }, 400);
      }
      console.warn("[shell] pane action failed:", err instanceof Error ? err.message : String(err));
      const error = toShellError(err);
      return c.json({ error: { code: error.code, message: error.safeMessage } }, (error.status ?? 500) as 500);
    }
  });
}
