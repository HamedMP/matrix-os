import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveProfileAuth } from "../../packages/sync-client/src/auth/token-store.js";
import { statusCommand } from "../../packages/sync-client/src/cli/commands/status.js";

const roots: string[] = [];
const originalHome = process.env.HOME;

async function tempHome() {
  const root = await mkdtemp(join(tmpdir(), "matrix-status-cli-"));
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

describe("status CLI command", () => {
  it("reports gateway health with bounded authenticated fetches", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: "ok" })));
    vi.stubGlobal("fetch", fetchImpl);
    const logs = captureLogs();

    await statusCommand.run!({ args: { json: true } } as never);

    expect(fetchImpl).toHaveBeenCalledWith("https://app.matrix-os.com/api/health", {
      headers: { Authorization: "Bearer cloud-token" },
      signal: expect.any(AbortSignal),
    });
    expect(JSON.parse(logs[0]!)).toEqual({
      v: 1,
      ok: true,
      data: {
        profile: "cloud",
        gatewayUrl: "https://app.matrix-os.com",
        authenticated: true,
        gateway: {
          reachable: true,
          status: "ok",
        },
      },
    });
  });

  it("surfaces recovering VPS status instead of flattening it to unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "VPS provisioning", status: "recovering" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const logs = captureLogs();

    await statusCommand.run!({ args: { json: true } } as never);

    expect(JSON.parse(logs[0]!)).toEqual({
      v: 1,
      ok: true,
      data: {
        profile: "cloud",
        gatewayUrl: "https://app.matrix-os.com",
        authenticated: true,
        gateway: {
          reachable: false,
          status: "recovering",
        },
      },
    });
  });

  it("surfaces new bounded lifecycle status slugs without code changes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "VPS provisioning", status: "upgrading" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const logs = captureLogs();

    await statusCommand.run!({ args: { json: true } } as never);

    expect(JSON.parse(logs[0]!).data.gateway.status).toBe("upgrading");
  });

  it("does not surface unsafe lifecycle status strings", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "VPS provisioning", status: "database://internal" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const logs = captureLogs();

    await statusCommand.run!({ args: { json: true } } as never);

    expect(JSON.parse(logs[0]!).data.gateway.status).toBe("unreachable");
  });
});
