import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHermesDashboardClient,
} from "../../packages/gateway/src/agent-config/hermes-client.js";

describe("Hermes dashboard client", () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    for (const path of cleanupPaths.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  it("forwards the caller signal and rejects oversized JSON responses", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ payload: "x".repeat(1024 * 1024) }),
      { headers: { "content-type": "application/json" } },
    ));
    const client = createHermesDashboardClient({
      baseUrl: "http://127.0.0.1:9119",
      fetchImpl,
    });
    const signal = new AbortController().signal;

    await expect(client.readJson("/api/status", signal)).rejects.toMatchObject({
      name: "HermesResponseTooLargeError",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:9119/api/status",
      expect.objectContaining({ signal, redirect: "error" }),
    );
  });

  it("sends bounded JSON mutations with the caller signal", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ ok: true }));
    const client = createHermesDashboardClient({
      baseUrl: "http://127.0.0.1:9119",
      fetchImpl,
    });
    const signal = new AbortController().signal;

    await expect(client.requestJson("/api/model/set", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "nous", model: "hermes-4-405b" }),
    }, signal)).resolves.toEqual({ ok: true });

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:9119/api/model/set",
      expect.objectContaining({
        method: "POST",
        signal,
        redirect: "error",
      }),
    );
  });

  it("authenticates protected Hermes 0.20 loopback endpoints with the host-owned session token", async () => {
    const homePath = mkdtempSync(join(tmpdir(), "hermes-dashboard-auth-"));
    cleanupPaths.push(homePath);
    const authFilePath = join(homePath, "system/agent-runtime/hermes-dashboard.env");
    mkdirSync(join(homePath, "system/agent-runtime"), { recursive: true });
    writeFileSync(authFilePath, [
      "HERMES_DASHBOARD_BASIC_AUTH_USERNAME=matrix",
      `HERMES_DASHBOARD_BASIC_AUTH_PASSWORD=${"a".repeat(64)}`,
      `HERMES_DASHBOARD_BASIC_AUTH_SECRET=${"b".repeat(64)}`,
      "",
    ].join("\n"), { mode: 0o600 });

    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(new URL(String(input)).pathname).toBe("/api/status");
      const sessionToken = headers.get("x-hermes-session-token");
      if (sessionToken === null) {
        return Response.json({ detail: "Unauthorized" }, { status: 401 });
      }
      expect(sessionToken).toBe("b".repeat(64));
      expect(headers.has("authorization")).toBe(false);
      expect(headers.has("cookie")).toBe(false);
      return Response.json({ gateway_running: true });
    });
    const client = createHermesDashboardClient({
      baseUrl: "http://127.0.0.1:9119",
      fetchImpl,
      authFilePath,
    });

    await expect(client.readJson("/api/status", new AbortController().signal)).resolves.toEqual({
      gateway_running: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
