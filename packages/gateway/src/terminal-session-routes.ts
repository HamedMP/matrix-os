import { relative } from "node:path";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  SessionRegistry,
  UUID_REGEX,
  type SessionInfo,
} from "./session-registry.js";
import { logTerminalDebug } from "./terminal-debug.js";

export const TERMINAL_SESSION_DELETE_BODY_LIMIT_BYTES = 1024;

export type TerminalSessionRouteRegistry = Pick<SessionRegistry, "list" | "getSession" | "destroy">;

export function registerTerminalSessionRoutes(
  app: Hono,
  options: { homePath: string; sessionRegistry: TerminalSessionRouteRegistry },
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

  app.delete("/api/terminal/pty-sessions/:id", terminalSessionDeleteBodyLimit, (c) => {
    const id = c.req.param("id");
    logTerminalDebug("rest-destroy-request", { sessionId: id });
    if (!UUID_REGEX.test(id)) return c.json({ error: "Invalid session ID" }, 400);
    const session = sessionRegistry.getSession(id);
    if (!session) return c.json({ ok: true }, 200);
    sessionRegistry.destroy(id);
    return c.json({ ok: true });
  });
}
