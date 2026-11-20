import { afterEach, describe, expect, it } from "vitest";
import { runBoardCli } from "../../packages/sync-client/src/cli/commands/board.js";
import { cleanupHomes, harness, json, ROOT_ID } from "./board-harness.js";

afterEach(async () => {
  await cleanupHomes();
});

// Fault detected: an agent cannot leave itself a follow-up, a person cannot make a
// private channel, or grants cannot be explained from the CLI.
describe("matrix board schedules, private channels and grants", () => {
  it("schedules a follow-up in a thread and cancels it", async () => {
    const h = await harness((call) => call.method === "POST"
      ? json({ schedule: { id: "sch_abcdefgh12", target: { kind: "thread", threadId: ROOT_ID, channel: "dev" }, text: "Check CI", nextRunAt: "2026-11-20T10:05:00.000Z", runCount: 0 } }, 201)
      : json({ ok: true }));
    expect(await runBoardCli(["schedule", ROOT_ID, "Check", "CI", "--in", "5m", "--every", "1h", "--times", "3"], h.deps)).toBe(0);
    expect(h.calls[0]).toMatchObject({ method: "POST", path: "/api/board/schedules", body: { thread: ROOT_ID, text: "Check CI", in: "5m", every: "1h", times: 3 } });
    expect(await runBoardCli(["schedule", "cancel", "sch_abcdefgh12"], h.deps)).toBe(0);
    expect(h.calls[1]).toMatchObject({ method: "DELETE", path: "/api/board/schedules/sch_abcdefgh12" });
    // Fault detected (review): `--as` was dropped, so the later post appeared without the chosen profile.
    expect(await runBoardCli(["schedule", "dev", "Follow up", "--in", "5m", "--as", "reviewer"], h.deps)).toBe(0);
    expect(h.calls[2]!.body).toMatchObject({ channel: "dev", profile: "reviewer" });
  });

  it("rejects bad schedule flags as usage errors before calling the board", async () => {
    const h = await harness(() => json({}));
    expect(await runBoardCli(["schedule", "dev", "x", "--in", "soon"], h.deps)).toBe(2);
    expect(await runBoardCli(["schedule", "dev", "x", "--times", "0"], h.deps)).toBe(2);
    expect(await runBoardCli(["schedule", "cancel", "nope"], h.deps)).toBe(2);
    expect(h.calls).toHaveLength(0);
  });

  it("creates a private channel and explains grants", async () => {
    const h = await harness((call) => call.path.endsWith("/explain")
      ? json({ explanation: { channel: "security/private", principal: "user:guest", pattern: "security/private", permissions: [], grants: [], source: "grants" } })
      : json({ channel: { path: "security/private", private: true } }, 201));
    expect(await runBoardCli(["channels", "create", "security/private", "--private"], h.deps)).toBe(0);
    expect(h.calls[0]).toMatchObject({ method: "POST", path: "/api/board/channels", body: { path: "security/private", private: true } });
    expect(await runBoardCli(["grants", "explain", "security/private", "--user", "user:guest"], h.deps)).toBe(0);
    expect(h.calls[1]).toMatchObject({ method: "GET", path: "/api/board/grants/explain", query: { channel: "security/private", principal: "user:guest" } });
    expect(h.out.join("\n")).toContain("no access");
  });
});
