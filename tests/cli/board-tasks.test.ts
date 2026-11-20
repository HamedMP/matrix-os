import { mkdir, readdir, readFile, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runBoardCli } from "../../packages/sync-client/src/cli/commands/board.js";
import { boardError, claimBody, cleanupHomes, harness, json, TASK_ID, TOKEN } from "./board-harness.js";

afterEach(async () => {
  vi.useRealTimers();
  await cleanupHomes();
});

const claimsDir = (home: string, profile = "default") => join(home, ".matrixos", "board", "claims", profile);
const taskResponse = () => json({ task: { state: "completed", needs: [] } });

// Fault detected: a worker agent that claimed a task cannot settle it by ID, or a stale
// claim's token leaks into logs or survives after the task is done.
describe("matrix board tasks", () => {
  it("creates a task with needs, a profile, labels and an immediate claim, and remembers the claim", async () => {
    const h = await harness(() => json({ root: { id: TASK_ID }, task: { state: "claimed" }, ...claimBody() }, 201));

    const code = await runBoardCli([
      "tasks", "create", "build", "fix", "the", "flake", "--needs", "msg_need0000000001", "--needs", "msg_need0000000002",
      "--for", "reviewer", "--claim", "--label", "pr=12",
    ], h.deps);

    expect(code).toBe(0);
    expect(h.calls[0]).toMatchObject({
      method: "POST", path: "/api/board/tasks",
      body: { channel: "build", text: "fix the flake", needs: ["msg_need0000000001", "msg_need0000000002"], forProfile: "reviewer", claim: true, labels: { pr: "12" } },
    });
    expect(await readdir(claimsDir(h.home))).toEqual([`${TASK_ID}.json`]);
    expect(h.out.join("\n")).not.toContain(TOKEN);
  });

  it("creates a plan from a file", async () => {
    const h = await harness(() => json({ tasks: [] }, 201));
    const plan = { channel: "build", tasks: [{ key: "a", text: "first" }, { key: "b", text: "second", needs: ["a"] }] };
    const file = join(h.home, "plan.json");
    await writeFile(file, JSON.stringify(plan));

    expect(await runBoardCli(["tasks", "create", "--plan", file, "--as", "planner"], h.deps)).toBe(0);
    expect(h.calls[0]!.body).toEqual({ ...plan, profile: "planner" });

    await writeFile(file, "{ not json");
    expect(await runBoardCli(["tasks", "create", "--plan", file], h.deps)).toBe(2);
  });

  it("claims the next ready task, stores it owner-only, and settles it by ID alone", async () => {
    const h = await harness((call) => call.path.endsWith("/claim") ? json(claimBody()) : taskResponse());

    expect(await runBoardCli(["tasks", "claim", "--ready", "build", "--label", "area=cli", "--from", "agent:planner", "--lease", "10m", "--as", "worker"], h.deps)).toBe(0);
    expect(h.calls[0]!.body).toEqual({ ready: "build", label: "area=cli", from: "agent:planner", leaseSeconds: 600, profile: "worker" });

    const dir = claimsDir(h.home, "worker");
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    const file = join(dir, `${TASK_ID}.json`);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ taskId: TASK_ID, epoch: 3, token: TOKEN, board: "General" });
    expect(h.out.join("\n")).not.toContain(TOKEN);

    expect(await runBoardCli(["tasks", "renew", TASK_ID, "--as", "worker"], h.deps)).toBe(0);
    expect(h.calls[1]).toMatchObject({ path: `/api/board/tasks/${TASK_ID}/renew`, body: { epoch: 3, token: TOKEN, leaseSeconds: 600 } });

    expect(await runBoardCli(["tasks", "complete", TASK_ID, "merged in #12", "--as", "worker"], h.deps)).toBe(0);
    expect(h.calls[2]).toMatchObject({ path: `/api/board/tasks/${TASK_ID}/complete`, body: { epoch: 3, token: TOKEN, result: "merged in #12" } });
    expect(await readdir(dir)).toEqual([]);
  });

  it("prints the claim token only in --json claim output", async () => {
    const h = await harness(() => json(claimBody()));
    await runBoardCli(["tasks", "claim", TASK_ID, "--json"], h.deps);
    expect(h.calls[0]!.body).toEqual({ id: TASK_ID });
    expect(JSON.parse(h.out[0]!)).toMatchObject({ ok: true, data: { claim: { taskId: TASK_ID, token: TOKEN } } });
  });

  it("sends each settle verb's body and forgets the claim after fail, release and block", async () => {
    const h = await harness((call) => call.path.endsWith("/claim") ? json(claimBody()) : taskResponse());
    const proof = { epoch: 3, token: TOKEN };

    await runBoardCli(["tasks", "claim", TASK_ID], h.deps);
    await runBoardCli(["tasks", "fail", TASK_ID, "tests", "red"], h.deps);
    await runBoardCli(["tasks", "claim", TASK_ID], h.deps);
    await runBoardCli(["tasks", "release", TASK_ID], h.deps);
    await runBoardCli(["tasks", "claim", TASK_ID], h.deps);
    await runBoardCli(["tasks", "block", TASK_ID, "which", "db?", "--kind", "needs_input"], h.deps);
    await runBoardCli(["tasks", "unblock", TASK_ID], h.deps);
    await runBoardCli(["tasks", "reopen", TASK_ID], h.deps);
    await runBoardCli(["tasks", "assign", TASK_ID, "reviewer"], h.deps);
    await runBoardCli(["tasks", "assign", TASK_ID, "--pool"], h.deps);
    await runBoardCli(["tasks", "needs", TASK_ID, "msg_need0000000001", "msg_need0000000002"], h.deps);
    await runBoardCli(["tasks", "cancel", TASK_ID, "not", "needed"], h.deps);

    const settles = h.calls.filter((call) => !call.path.endsWith("/claim")).map((call) => [call.path.split("/").at(-1), call.body]);
    expect(settles).toEqual([
      ["fail", { ...proof, reason: "tests red" }],
      ["release", proof],
      ["block", { ...proof, reason: "which db?", kind: "needs_input" }],
      ["unblock", {}],
      ["reopen", {}],
      ["assign", { profile: "reviewer" }],
      ["assign", { profile: null }],
      ["needs", { needs: ["msg_need0000000001", "msg_need0000000002"] }],
      ["cancel", { reason: "not needed" }],
    ]);
    expect(await readdir(claimsDir(h.home))).toEqual([]);
  });

  it("settles without proof when no claim is remembered, and keeps the claim when the settle fails", async () => {
    const h = await harness((call) => call.path.endsWith("/claim") ? json(claimBody()) : boardError("claim_lost", 409, "Your claim on this task has lapsed.", "read the task again; claim it if it is ready"));
    expect(await runBoardCli(["tasks", "complete", TASK_ID], h.deps)).toBe(1);
    expect(h.calls[0]!.body).toEqual({});

    await runBoardCli(["tasks", "claim", TASK_ID], h.deps);
    expect(await runBoardCli(["tasks", "complete", TASK_ID, "--json"], h.deps)).toBe(1);
    expect(JSON.parse(h.out.at(-1)!)).toMatchObject({ ok: false, reason: "claim_lost", next: "read the task again; claim it if it is ready" });
    // A lapsed claim proves nothing any more: drop it so a later complete does not resend it.
    expect(await readdir(claimsDir(h.home))).toEqual([]);
  });

  it("re-polls a ready claim client-side when --wait is longer than one server wait", async () => {
    vi.useFakeTimers({ now: 0 });
    let attempts = 0;
    const h = await harness(() => {
      attempts += 1;
      if (attempts < 3) {
        vi.advanceTimersByTime(25_000);
        return boardError("nothing_ready", 404, "No task is ready to claim.");
      }
      return json(claimBody());
    });

    expect(await runBoardCli(["tasks", "claim", "--ready", "build", "--wait", "2m"], h.deps)).toBe(0);
    expect(h.calls.map((call) => (call.body as { waitSeconds?: number }).waitSeconds)).toEqual([25, 25, 25]);
  });

  it("exits 1 with nothing_ready when the wait runs out", async () => {
    const h = await harness(() => boardError("nothing_ready", 404, "No task is ready to claim.", "wait for a task.ready event, then claim again"));
    expect(await runBoardCli(["tasks", "claim", "--ready", "build", "--json"], h.deps)).toBe(1);
    expect(h.calls[0]!.body).toEqual({ ready: "build" });
    expect(JSON.parse(h.out[0]!)).toMatchObject({ reason: "nothing_ready" });
  });

  it("lists tasks by channel and state", async () => {
    const h = await harness(() => json({ tasks: [{ root: { id: TASK_ID, text: "fix it", by: { id: "user:u" } }, replyCount: 0, task: { state: "ready" } }] }));
    expect(await runBoardCli(["tasks", "list", "build", "--state", "ready"], h.deps)).toBe(0);
    expect(h.calls[0]).toMatchObject({ path: "/api/board/tasks", query: { channel: "build", state: "ready" } });
    expect(h.out.join("\n")).toContain(TASK_ID);
    expect(await runBoardCli(["tasks", "list", "--state", "sleeping"], h.deps)).toBe(2);
  });

  it("ignores a symlinked claim file and prunes claims older than a day", async () => {
    const h = await harness((call) => call.path.endsWith("/claim") ? json(claimBody({ taskId: "msg_fresh00000001" })) : taskResponse());
    const dir = claimsDir(h.home);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const stale = join(dir, "msg_stale00000001.json");
    await writeFile(stale, JSON.stringify({ taskId: "msg_stale00000001", epoch: 1, token: TOKEN, board: "General", claimedAt: "2026-01-01T00:00:00.000Z" }), { mode: 0o600 });
    const old = new Date(Date.now() - 48 * 3600 * 1000);
    await utimes(stale, old, old);
    const elsewhere = join(h.home, "planted.json");
    await writeFile(elsewhere, JSON.stringify({ taskId: TASK_ID, epoch: 9, token: "d".repeat(64), board: "General", claimedAt: "x" }));
    await symlink(elsewhere, join(dir, `${TASK_ID}.json`));

    await runBoardCli(["tasks", "complete", TASK_ID], h.deps);
    expect(h.calls[0]!.body).toEqual({});

    await runBoardCli(["tasks", "claim", "msg_fresh00000001"], h.deps);
    expect((await readdir(dir)).sort()).toEqual(["msg_fresh00000001.json", `${TASK_ID}.json`]);
  });
});
