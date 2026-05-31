import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveProfileAuth } from "../../packages/sync-client/src/auth/token-store.js";
import { doctorCommand } from "../../packages/sync-client/src/cli/commands/doctor.js";

afterEach(() => {
  process.env.HOME = originalHome;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const originalHome = process.env.HOME;

describe("doctor CLI command", () => {
  it("reports profile, auth, daemon, gateway, and protocol checks in JSON", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: "ok" })));
    vi.stubGlobal("fetch", fetchImpl);
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
      logs.push(String(line));
    });

    await doctorCommand.run!({ args: { dev: true, token: "tok", json: true } } as never);

    const parsed = JSON.parse(logs[0]);
    expect(parsed.v).toBe(1);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.checks.map((check: { name: string }) => check.name)).toEqual([
      "profile",
      "auth",
      "daemon",
      "gateway",
      "protocol",
    ]);
    expect(fetchImpl).toHaveBeenCalledWith("http://localhost:4000/api/system/info", {
      headers: { Authorization: "Bearer tok" },
      signal: expect.any(AbortSignal),
    });
  });

  it("uses saved profile auth when probing the gateway", async () => {
    const root = await mkdtemp(join(tmpdir(), "matrix-doctor-cli-"));
    process.env.HOME = root;
    await saveProfileAuth("cloud", {
      accessToken: "cloud-token",
      expiresAt: Date.now() + 60_000,
      userId: "user_cloud",
      handle: "cloud",
    });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: "ok" })));
    vi.stubGlobal("fetch", fetchImpl);
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
      logs.push(String(line));
    });

    await doctorCommand.run!({ args: { json: true } } as never);

    const parsed = JSON.parse(logs[0]);
    expect(parsed.data.checks.find((check: { name: string }) => check.name === "gateway").ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith("https://app.matrix-os.com/api/system/info", {
      headers: { Authorization: "Bearer cloud-token" },
      signal: expect.any(AbortSignal),
    });
    await rm(root, { recursive: true, force: true });
  });

  it("prompts to refresh expired profile auth", async () => {
    const root = await mkdtemp(join(tmpdir(), "matrix-doctor-cli-"));
    process.env.HOME = root;
    await saveProfileAuth("cloud", {
      accessToken: "expired-token",
      expiresAt: Date.parse("2026-05-29T23:24:06.000Z"),
      userId: "user_cloud",
      handle: "cloud",
    });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: "ok" })));
    vi.stubGlobal("fetch", fetchImpl);
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
      logs.push(String(line));
    });

    await doctorCommand.run!({ args: { json: true } } as never);

    const parsed = JSON.parse(logs[0]);
    expect(parsed.data.checks.find((check: { name: string }) => check.name === "auth")).toEqual({
      name: "auth",
      ok: false,
      code: "auth_expired",
      hint: "Run `matrix login --profile cloud` to refresh.",
    });
    expect(fetchImpl).toHaveBeenCalledWith("https://app.matrix-os.com/api/system/info", {
      signal: expect.any(AbortSignal),
    });
    await rm(root, { recursive: true, force: true });
  });
});
