import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveProfileAuth } from "../../packages/sync-client/src/auth/token-store.js";
import { loginCommand } from "../../packages/sync-client/src/cli/commands/login.js";
import { peersCommand } from "../../packages/sync-client/src/cli/commands/peers.js";

const roots: string[] = [];
const originalHome = process.env.HOME;
const originalGatewayUrl = process.env.MATRIXOS_GATEWAY_URL;
const originalPlatformUrl = process.env.MATRIXOS_PLATFORM_URL;

async function tempHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "matrix-peers-cli-"));
  roots.push(root);
  process.env.HOME = root;
  return root;
}

function captureLogs(): string[] {
  const logs: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
    logs.push(String(line));
  });
  return logs;
}

function captureErrors(): string[] {
  const errors: string[] = [];
  vi.spyOn(console, "error").mockImplementation((line?: unknown) => {
    errors.push(String(line));
  });
  return errors;
}

beforeEach(async () => {
  process.exitCode = undefined;
  process.env.MATRIXOS_GATEWAY_URL = "http://localhost:4010";
  process.env.MATRIXOS_PLATFORM_URL = "http://localhost:9010";
  await tempHome();
});

afterEach(async () => {
  process.env.HOME = originalHome;
  process.env.MATRIXOS_GATEWAY_URL = originalGatewayUrl;
  process.env.MATRIXOS_PLATFORM_URL = originalPlatformUrl;
  process.exitCode = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("peers CLI command", () => {
  it("uses profile-scoped dev login auth without legacy sync config", async () => {
    await loginCommand.run!({ args: { dev: true } } as never);
    await rm(join(process.env.HOME!, ".matrixos", "config.json"), { force: true });
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          peers: [{ peerId: "peer-1", hostname: "devhost", connectedAt: 1700000000000 }],
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchImpl);
    const logs = captureLogs();

    await peersCommand.run!({ args: {} } as never);

    expect(fetchImpl).toHaveBeenCalledWith("http://localhost:4010/api/sync/status", {
      headers: { Authorization: "Bearer dev-token" },
      signal: expect.any(AbortSignal),
    });
    expect(logs).toEqual([
      "Connected peers:",
      "  peer-1 (devhost) \u2014 since 2023-11-14T22:13:20.000Z",
    ]);
  });

  it("honors explicit profile, gateway, and token overrides", async () => {
    await mkdir(join(process.env.HOME!, ".matrixos"), { recursive: true });
    await writeFile(
      join(process.env.HOME!, ".matrixos", "profiles.json"),
      JSON.stringify({
        active: "cloud",
        profiles: {
          cloud: {
            platformUrl: "https://platform.example",
            gatewayUrl: "https://gateway.example",
          },
          local: {
            platformUrl: "http://localhost:9000",
            gatewayUrl: "http://localhost:4000",
          },
        },
      }),
      { flag: "wx" },
    );
    await saveProfileAuth("cloud", {
      accessToken: "cloud-token",
      expiresAt: Date.now() + 60_000,
      userId: "user_cloud",
      handle: "cloud",
    });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ peers: [] })));
    vi.stubGlobal("fetch", fetchImpl);
    const logs = captureLogs();

    await peersCommand.run!({
      args: {
        profile: "cloud",
        gateway: "https://override.example",
        token: "operator-token",
      },
    } as never);

    expect(fetchImpl).toHaveBeenCalledWith("https://override.example/api/sync/status", {
      headers: { Authorization: "Bearer operator-token" },
      signal: expect.any(AbortSignal),
    });
    expect(logs).toEqual(["No peers connected."]);
  });

  it("prints JSON output when requested", async () => {
    await loginCommand.run!({ args: { dev: true } } as never);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            peers: [{ peerId: "peer-1", hostname: "devhost", connectedAt: 1700000000000 }],
          }),
        ),
      ),
    );
    const logs = captureLogs();

    await peersCommand.run!({ args: { json: true } } as never);

    expect(JSON.parse(logs[0]!)).toEqual({
      v: 1,
      ok: true,
      data: {
        profile: "local",
        gatewayUrl: "http://localhost:4010",
        peers: [{ peerId: "peer-1", hostname: "devhost", connectedAt: 1700000000000 }],
      },
    });
  });

  it("emits safe JSON errors without exposing gateway response bodies", async () => {
    await loginCommand.run!({ args: { dev: true } } as never);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("provider exploded", { status: 502 })),
    );
    const errors = captureErrors();

    await peersCommand.run!({ args: { json: true } } as never);

    expect(process.exitCode).toBe(1);
    expect(JSON.parse(errors[0]!)).toEqual({
      v: 1,
      error: { code: "peers_request_failed", message: "Request failed" },
    });
    expect(errors[0]).not.toContain("provider exploded");
  });
});
