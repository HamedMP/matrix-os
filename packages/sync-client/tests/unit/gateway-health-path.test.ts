import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveProfileAuth } from "../../src/auth/token-store.js";
import { statusCommand } from "../../src/cli/commands/status.js";
import { doctorCommand } from "../../src/cli/commands/doctor.js";
import { saveProfiles } from "../../src/lib/profiles.js";

const originalHome = process.env.HOME;

async function withIsolatedHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "matrix-health-path-"));
  process.env.HOME = home;
  await saveProfiles({
    active: "local",
    profiles: {
      local: {
        platformUrl: "http://localhost:9000",
        gatewayUrl: "http://localhost:4100",
      },
    },
  });
  await saveProfileAuth("local", {
    accessToken: "dev-token",
    expiresAt: Date.now() + 60_000,
    userId: "user_dev",
    handle: "dev",
  });
  return home;
}

describe("gateway health checks", () => {
  let home: string;

  beforeEach(async () => {
    process.exitCode = undefined;
    home = await withIsolatedHome();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    process.env.HOME = originalHome;
    if (home) {
      await rm(home, { recursive: true, force: true });
    }
    process.exitCode = undefined;
  });

  it("matrix status checks the public /health endpoint", async () => {
    const seenUrls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      seenUrls.push(String(url));
      return new Response(JSON.stringify({ status: "ok" }), {
        status: String(url).endsWith("/health") ? 200 : 401,
        headers: { "content-type": "application/json" },
      });
    }));
    const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await statusCommand.run?.({ args: { profile: "local", json: true }, rawArgs: [] });

    expect(seenUrls).toEqual(["http://localhost:4100/health"]);
    expect(process.exitCode).toBeUndefined();
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('"reachable":true'));
  });

  it("matrix doctor reports gateway OK when public /health is reachable", async () => {
    const seenUrls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      seenUrls.push(String(url));
      return new Response(JSON.stringify({ status: "ok" }), {
        status: String(url).endsWith("/health") ? 200 : 401,
        headers: { "content-type": "application/json" },
      });
    }));
    vi.doMock("../../src/cli/daemon-client.js", () => ({
      isDaemonRunning: async () => true,
    }));
    const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await doctorCommand.run?.({ args: { profile: "local" }, rawArgs: [] });

    expect(seenUrls).toEqual(["http://localhost:4100/health"]);
    expect(stdout).toHaveBeenCalledWith("OK gateway");
  });
});
