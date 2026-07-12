import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mkdtemp } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShellRoutes } from "../../packages/gateway/src/shell/routes.js";
import { createWorkspaceRoutes } from "../../packages/gateway/src/workspace-routes.js";
import type { createWorkspaceSessionOrchestrator } from "../../packages/gateway/src/workspace-session-orchestrator.js";

function post(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("workspace and terminal session route composition", () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    for (const path of cleanupPaths.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it("keeps terminal sessions canonical while workspace sessions use their own namespace", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-session-route-composition-"));
    cleanupPaths.push(homePath);
    const workspaceSession = {
      id: "sess_mobile",
      kind: "shell" as const,
      status: "running" as const,
      ownerId: "user_mobile",
      createdAt: "2026-07-12T00:00:00.000Z",
      updatedAt: "2026-07-12T00:00:00.000Z",
      runtime: {
        type: "zellij" as const,
        status: "running" as const,
        zellijSession: "matrix-sess_mobile",
      },
    };
    const sessionOrchestrator = {
      startSession: vi.fn(async () => ({ ok: true as const, status: 201, session: workspaceSession })),
      listSessions: vi.fn(async () => ({ ok: true as const, sessions: [workspaceSession], nextCursor: null })),
      getSession: vi.fn(async () => ({ ok: true as const, session: workspaceSession })),
      sendInput: vi.fn(async () => ({ ok: true as const, session: workspaceSession })),
      attachSession: vi.fn(async () => ({ ok: true as const, terminalSessionId: "term_mobile" })),
      stopSession: vi.fn(async () => ({ ok: true as const, session: workspaceSession })),
    } satisfies ReturnType<typeof createWorkspaceSessionOrchestrator>;
    const shellRegistry = {
      list: vi.fn(async () => []),
      create: vi.fn(async ({ name }: { name: string }) => ({ name })),
      delete: vi.fn(async () => undefined),
    };
    const app = new Hono();
    app.route("/api/terminal", createShellRoutes({ registry: shellRegistry }));
    app.route("/api", createShellRoutes({ registry: shellRegistry }));
    app.route("/", createWorkspaceRoutes({
      homePath,
      sessionOrchestrator,
      getOwnerScope: () => ({ type: "user", id: "user_mobile" }),
    }));

    const terminal = await app.request(post("/api/terminal/sessions", { name: "mobile-shell" }));
    expect(terminal.status).toBe(201);
    expect(shellRegistry.create).toHaveBeenCalledWith({ name: "mobile-shell" });

    const workspace = await app.request(post("/api/workspace/sessions", { kind: "shell" }));
    expect(workspace.status).toBe(201);
    expect(sessionOrchestrator.startSession).toHaveBeenCalledWith({
      ownerScope: { type: "user", id: "user_mobile" },
      request: { kind: "shell" },
    });

    const ambiguousLegacy = await app.request(post("/api/sessions", { kind: "shell" }));
    expect(ambiguousLegacy.status).toBe(400);
    expect(sessionOrchestrator.startSession).toHaveBeenCalledTimes(1);
  });
});
