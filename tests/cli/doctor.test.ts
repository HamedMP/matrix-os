import { describe, expect, it, vi, afterEach } from "vitest";
import { doctorCommand } from "../../packages/sync-client/src/cli/commands/doctor.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("doctor CLI command", () => {
  it("reports profile, auth, daemon, gateway, and protocol checks in JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: "ok" }))));
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
  });
});
