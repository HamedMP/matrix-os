import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loginCommand } from "../../packages/sync-client/src/cli/commands/login.js";
import { logoutCommand } from "../../packages/sync-client/src/cli/commands/logout.js";
import { statusCommand } from "../../packages/sync-client/src/cli/commands/status.js";
import { whoamiCommand } from "../../packages/sync-client/src/cli/commands/whoami.js";
import { saveProfileAuth } from "../../packages/sync-client/src/auth/token-store.js";

const roots: string[] = [];
const originalHome = process.env.HOME;

async function tempHome() {
  const root = await mkdtemp(join(tmpdir(), "matrix-profile-auth-cli-"));
  roots.push(root);
  process.env.HOME = root;
  return root;
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
});

afterEach(async () => {
  process.env.HOME = originalHome;
  process.exitCode = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("profile-aware auth CLI commands", () => {
  it("writes dev login credentials to the local profile only", async () => {
    const home = process.env.HOME!;
    const logs = captureLogs();

    await loginCommand.run!({ args: { dev: true, json: true } } as never);

    const auth = JSON.parse(
      await readFile(join(home, ".matrixos", "profiles", "local", "auth.json"), "utf-8"),
    );
    const profiles = JSON.parse(await readFile(join(home, ".matrixos", "profiles.json"), "utf-8"));
    await expect(readFile(join(home, ".matrixos", "auth.json"), "utf-8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(auth).toMatchObject({ accessToken: "dev-token", userId: "user_dev", handle: "dev" });
    expect(profiles.active).toBe("local");
    expect(profiles.profiles.local).toEqual({
      platformUrl: "http://localhost:9000",
      gatewayUrl: "http://localhost:4000",
    });
    expect(JSON.parse(logs[0])).toEqual({
      v: 1,
      ok: true,
      data: {
        profile: "local",
        handle: "dev",
        gatewayUrl: "http://localhost:4000",
        platformUrl: "http://localhost:9000",
      },
    });
  });

  it("logs out only the selected profile", async () => {
    const home = process.env.HOME!;
    await saveProfileAuth("cloud", {
      accessToken: "cloud-token",
      expiresAt: Date.now() + 60_000,
      userId: "user_cloud",
      handle: "cloud",
    });
    await loginCommand.run!({ args: { dev: true } } as never);
    const logs = captureLogs();

    await logoutCommand.run!({ args: { profile: "local", json: true } } as never);

    await expect(readFile(join(home, ".matrixos", "profiles", "local", "auth.json"), "utf-8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(home, ".matrixos", "profiles", "cloud", "auth.json"), "utf-8")).resolves.toContain("cloud-token");
    expect(JSON.parse(logs[0])).toEqual({
      v: 1,
      ok: true,
      data: { profile: "local", loggedOut: true },
    });
  });

  it("reports identity for the active profile and honors per-command profile overrides", async () => {
    const logs = captureLogs();
    await saveProfileAuth("cloud", {
      accessToken: "cloud-token",
      expiresAt: Date.now() + 60_000,
      userId: "user_cloud",
      handle: "cloud",
    });
    await loginCommand.run!({ args: { dev: true } } as never);

    await whoamiCommand.run!({ args: { json: true } } as never);
    await whoamiCommand.run!({ args: { profile: "cloud", json: true } } as never);

    expect(logs.slice(-2).map((line) => JSON.parse(line))).toEqual([
      {
        v: 1,
        ok: true,
        data: {
          profile: "local",
          authenticated: true,
          userId: "user_dev",
          handle: "dev",
        },
      },
      {
        v: 1,
        ok: true,
        data: {
          profile: "cloud",
          authenticated: true,
          userId: "user_cloud",
          handle: "cloud",
        },
      },
    ]);
  });

  it("uses the resolved profile and token for status checks", async () => {
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
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: "ok" })));
    vi.stubGlobal("fetch", fetchImpl);
    const logs = captureLogs();

    await statusCommand.run!({ args: { json: true } } as never);

    expect(fetchImpl).toHaveBeenCalledWith("https://gateway.example/api/health", {
      headers: { Authorization: "Bearer cloud-token" },
      signal: expect.any(AbortSignal),
    });
    expect(JSON.parse(logs[0])).toEqual({
      v: 1,
      ok: true,
      data: {
        profile: "cloud",
        gatewayUrl: "https://gateway.example",
        authenticated: true,
        gateway: { reachable: true, status: "ok" },
      },
    });
  });
});
