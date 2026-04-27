import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveProfileAuth } from "../../packages/sync-client/src/auth/token-store.js";
import { instanceCommand } from "../../packages/sync-client/src/cli/commands/instance.js";

const roots: string[] = [];
const originalHome = process.env.HOME;

async function tempHome() {
  const root = await mkdtemp(join(tmpdir(), "matrix-instance-cli-"));
  roots.push(root);
  process.env.HOME = root;
}

function captureLogs() {
  const logs: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
    logs.push(String(line));
  });
  return logs;
}

beforeEach(async () => {
  process.exitCode = undefined;
  await tempHome();
  await saveProfileAuth("cloud", {
    accessToken: "cloud-token",
    expiresAt: Date.now() + 60_000,
    userId: "user_cloud",
    handle: "cloud",
  });
});

afterEach(async () => {
  process.env.HOME = originalHome;
  process.exitCode = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("instance CLI command", () => {
  it("registers info, restart, and logs subcommands", () => {
    expect(Object.keys(instanceCommand.subCommands ?? {}).sort()).toEqual([
      "info",
      "logs",
      "restart",
    ]);
  });

  it("calls profile-scoped instance endpoints with bounded fetches", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/instance/restart")) {
        expect(init?.method).toBe("POST");
        return new Response(JSON.stringify({ restarted: true }));
      }
      if (url.endsWith("/api/instance/logs")) {
        return new Response(JSON.stringify({ lines: ["ready"] }));
      }
      return new Response(JSON.stringify({ status: "running", handle: "cloud" }));
    });
    vi.stubGlobal("fetch", fetchImpl);
    const logs = captureLogs();

    await instanceCommand.subCommands!.info.run!({ args: { json: true } } as never);
    await instanceCommand.subCommands!.restart.run!({ args: { json: true } } as never);
    await instanceCommand.subCommands!.logs.run!({ args: { json: true } } as never);

    expect(fetchImpl).toHaveBeenCalledWith("https://app.matrix-os.com/api/instance", {
      headers: { Authorization: "Bearer cloud-token" },
      signal: expect.any(AbortSignal),
    });
    expect(fetchImpl).toHaveBeenCalledWith("https://app.matrix-os.com/api/instance/restart", {
      method: "POST",
      headers: { Authorization: "Bearer cloud-token" },
      signal: expect.any(AbortSignal),
    });
    expect(fetchImpl).toHaveBeenCalledWith("https://app.matrix-os.com/api/instance/logs", {
      headers: { Authorization: "Bearer cloud-token" },
      signal: expect.any(AbortSignal),
    });
    expect(logs.map((line) => JSON.parse(line))).toEqual([
      { v: 1, ok: true, data: { status: "running", handle: "cloud" } },
      { v: 1, ok: true, data: { restarted: true } },
      { v: 1, ok: true, data: { lines: ["ready"] } },
    ]);
  });

  it("emits generic JSON errors without exposing response bodies", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("provider exploded", { status: 502 })));
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line?: unknown) => {
      errors.push(String(line));
    });

    await instanceCommand.subCommands!.info.run!({ args: { json: true } } as never);

    expect(process.exitCode).toBe(1);
    expect(JSON.parse(errors[0])).toEqual({
      v: 1,
      error: { code: "instance_request_failed", message: "Request failed" },
    });
    expect(errors[0]).not.toContain("provider exploded");
  });
});
