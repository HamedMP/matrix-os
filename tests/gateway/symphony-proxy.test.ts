import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createElixirSymphonyProxyRoutes } from "../../packages/gateway/src/symphony/proxy.js";
import { MissingRequestPrincipalError } from "../../packages/gateway/src/request-principal.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Elixir Symphony proxy routes", () => {
  it("wires the gateway to the Elixir proxy instead of the TypeScript orchestrator route table", async () => {
    const server = await readFile(resolve(repoRoot, "packages/gateway/src/server.ts"), "utf8");

    expect(server).toContain("createElixirSymphonyProxyRoutes");
    expect(server).toContain('app.route("/api/symphony", createElixirSymphonyProxyRoutes())');
    expect(server).not.toContain("createMatrixSymphonyOrchestrator({");
    expect(server).not.toContain("KyselySymphonyRepository");
    expect(server).not.toContain("createSymphonyRoutes({");
  });

  it("normalizes loopback Elixir state without exposing raw upstream errors", async () => {
    const fetchImpl = vi.fn(async () => json({
      generated_at: "2026-05-25T00:00:00Z",
      counts: { running: 1, retrying: 1 },
      running: [{
        issue_identifier: "MAT-32",
        state: "In Progress",
        session_id: "thread-1-turn-2",
        turn_count: 2,
        last_event: "session_token_event",
        last_message: "session completed with token lin_secret123",
      }],
      retrying: [{ issue_identifier: "MAT-33", attempt: 2, error: "linear exploded with token lin_secret" }],
    }));
    const app = createElixirSymphonyProxyRoutes({
      fetchImpl,
      getPrincipal: () => ({ userId: "user_123", source: "dev-default" }),
    });

    const res = await app.request("/state");

    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:4766/api/v1/state", expect.objectContaining({
      method: "GET",
      signal: expect.any(AbortSignal),
    }));
    const body = await res.json();
    expect(body).toMatchObject({
      service: { status: "ready", generatedAt: "2026-05-25T00:00:00Z" },
      groups: {
        running: [{ issueIdentifier: "MAT-32", sessionId: "thread-1-turn-2", turnCount: 2, latestEvent: "[redacted]", latestMessage: "session completed with [redacted] [redacted]" }],
        needsAttention: [{ issueIdentifier: "MAT-33", attempt: 2 }],
      },
    });
    expect(JSON.stringify(body)).not.toContain("lin_secret");
  });

  it("rejects unauthenticated callers before contacting Elixir", async () => {
    const fetchImpl = vi.fn();
    const app = createElixirSymphonyProxyRoutes({
      fetchImpl,
      getPrincipal: () => {
        throw new MissingRequestPrincipalError();
      },
    });

    const res = await app.request("/state");

    expect(res.status).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("proxies refresh with body limits and an upstream timeout", async () => {
    const fetchImpl = vi.fn(async () => json({ requested_at: "2026-05-25T00:00:00Z" }, { status: 202 }));
    const app = createElixirSymphonyProxyRoutes({
      fetchImpl,
      getPrincipal: () => ({ userId: "user_123", source: "dev-default" }),
      timeoutMs: 1234,
    });

    const res = await app.request("/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(202);
    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:4766/api/v1/refresh", expect.objectContaining({
      method: "POST",
      signal: expect.any(AbortSignal),
    }));
    expect(await res.json()).toEqual({ requested: true, requestedAt: "2026-05-25T00:00:00Z" });
  });

  it("maps malformed refresh responses to generic invalid-response errors", async () => {
    const fetchImpl = vi.fn(async () => json({ requested_at: 123 }));
    const app = createElixirSymphonyProxyRoutes({
      fetchImpl,
      getPrincipal: () => ({ userId: "user_123", source: "dev-default" }),
    });

    const res = await app.request("/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: { code: "invalid_response", message: "Symphony returned an invalid response" } });
  });

  it("maps offline or invalid upstream responses to generic unavailable errors", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:4766");
    });
    const app = createElixirSymphonyProxyRoutes({
      fetchImpl,
      getPrincipal: () => ({ userId: "user_123", source: "dev-default" }),
    });

    const res = await app.request("/state");

    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain("ECONNREFUSED");
  });

  it("validates issue identifiers before proxying detail requests", async () => {
    const fetchImpl = vi.fn();
    const app = createElixirSymphonyProxyRoutes({
      fetchImpl,
      getPrincipal: () => ({ userId: "user_123", source: "dev-default" }),
    });

    const res = await app.request("/issues/not-a-linear-key");

    expect(res.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("preserves upstream missing-resource errors as not found", async () => {
    const fetchImpl = vi.fn(async () => json({ error: { code: "issue_not_found" } }, { status: 404 }));
    const app = createElixirSymphonyProxyRoutes({
      fetchImpl,
      getPrincipal: () => ({ userId: "user_123", source: "dev-default" }),
    });

    const res = await app.request("/issues/MAT-404");

    expect(res.status).toBe(404);
    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:4766/api/v1/issues/MAT-404", expect.objectContaining({
      method: "GET",
      signal: expect.any(AbortSignal),
    }));
    expect(await res.json()).toEqual({ error: { code: "not_found", message: "Symphony resource not found" } });
  });

  it("scrubs issue logs and recent events before returning detail payloads", async () => {
    const longWorkspacePath = `/tmp/${"workspace-".repeat(80)}`;
    const fetchImpl = vi.fn(async () => json({
      issue_identifier: "MAT-32",
      status: "running",
      workspace: {
        path: longWorkspacePath,
      },
      running: {
        last_event: "session_token_event",
        last_message: "raw lin_secret token leaked",
      },
      logs: {
        codex_session_logs: ["session started", "raw lin_secret token leaked"],
      },
      recent_events: [{ at: "2026-05-25T00:00:00Z", event: "token_usage", message: "gho_token should not leak" }],
    }));
    const app = createElixirSymphonyProxyRoutes({
      fetchImpl,
      getPrincipal: () => ({ userId: "user_123", source: "dev-default" }),
    });

    const res = await app.request("/issues/MAT-32");

    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:4766/api/v1/issues/MAT-32", expect.objectContaining({
      method: "GET",
      signal: expect.any(AbortSignal),
    }));
    const body = await res.json();
    expect(body.latestEvent).toBe("[redacted]");
    expect(body.latestMessage).toBe("raw [redacted] [redacted] leaked");
    expect(body.workspacePath).toBe(longWorkspacePath.slice(0, 500));
    expect(body.logs.codexSessionLogs).toEqual(["session started", "raw [redacted] [redacted] leaked"]);
    expect(body.recentEvents[0].event).toBe("token_usage");
    expect(body.recentEvents[0].message).toBe("[redacted] should not leak");
    expect(JSON.stringify(body)).not.toContain("lin_secret");
    expect(JSON.stringify(body)).not.toContain("gho_token");
  });

  it("proxies stop requests to the Elixir run endpoint", async () => {
    const fetchImpl = vi.fn(async () => json({ stopped: true }));
    const app = createElixirSymphonyProxyRoutes({
      fetchImpl,
      getPrincipal: () => ({ userId: "user_123", source: "dev-default" }),
    });

    const res = await app.request("/runs/MAT-32/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:4766/api/v1/runs/MAT-32/stop", expect.objectContaining({
      method: "POST",
      signal: expect.any(AbortSignal),
    }));
    expect(await res.json()).toEqual({ stopped: true });
  });
});
