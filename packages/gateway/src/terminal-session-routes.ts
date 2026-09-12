import { relative } from "node:path";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  SessionRegistry,
  UUID_REGEX,
  type SessionInfo,
} from "./session-registry.js";
import { logTerminalDebug } from "./terminal-debug.js";
import { ProjectFenceError } from "./collaboration/project-fence.js";

export const TERMINAL_SESSION_DELETE_BODY_LIMIT_BYTES = 1024;

export type TerminalSessionRouteRegistry = Pick<SessionRegistry, "list" | "getSession" | "destroy">;

export function registerTerminalSessionRoutes(
  app: Hono,
  options: {
    homePath: string;
    sessionRegistry: TerminalSessionRouteRegistry;
    withProjectAdmission?: <T>(
      context: Context,
      cwd: string,
      operation: () => Promise<T>,
    ) => Promise<T>;
  },
): void {
  const { homePath, sessionRegistry } = options;
  const terminalSessionDeleteBodyLimit = bodyLimit({
    maxSize: TERMINAL_SESSION_DELETE_BODY_LIMIT_BYTES,
  });

  app.get("/api/terminal/pty-sessions", (c) => {
    const publicSessions = sessionRegistry.list().map((session: SessionInfo) => {
      const displayCwd = relative(homePath, session.cwd) || "~";
      return {
        sessionId: session.sessionId,
        cwd: displayCwd,
        state: session.state,
        exitCode: session.exitCode,
        createdAt: session.createdAt,
        lastAttachedAt: session.lastAttachedAt,
        attachedClients: session.attachedClients,
      };
    });
    return c.json(publicSessions);
  });

  app.delete("/api/terminal/pty-sessions/:id", terminalSessionDeleteBodyLimit, async (c) => {
    const id = c.req.param("id");
    logTerminalDebug("rest-destroy-request", { sessionId: id });
    if (!UUID_REGEX.test(id)) return c.json({ error: "Invalid session ID" }, 400);
    const session = sessionRegistry.getSession(id);
    if (!session) return c.json({ ok: true }, 200);
    try {
      const destroy = async () => {
        sessionRegistry.destroy(id);
        return c.json({ ok: true });
      };
      return options.withProjectAdmission
        ? await options.withProjectAdmission(c, session.cwd, destroy)
        : await destroy();
    } catch (err: unknown) {
      if (err instanceof ProjectFenceError) {
        if (["fenced", "scope_required", "conflict", "not_found"].includes(err.code)) {
          return c.json({
            error: { code: "project_shared", message: "Use the shared project route" },
          }, 409);
        }
        return c.json({ error: { code: "terminal_unavailable", message: "Request failed" } }, 503);
      }
      console.warn(
        "[terminal] pty session deletion failed:",
        err instanceof Error ? err.name : "UnknownError",
      );
      return c.json({ error: { code: "terminal_unavailable", message: "Request failed" } }, 500);
    }
  });
}
