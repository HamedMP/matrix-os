import { EventEmitter } from "node:events";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runBoardCli } from "../../packages/sync-client/src/cli/commands/board.js";
import type { BoardChild } from "../../packages/sync-client/src/cli/board-cli-support.js";
import { boardError, claimBody, cleanupHomes, harness, json, TASK_ID, TOKEN } from "./board-harness.js";

afterEach(async () => {
  vi.useRealTimers();
  await cleanupHomes();
});

const PID = 4242;

class FakeChild extends EventEmitter implements BoardChild {
  readonly pid = PID;
  killed: string[] = [];
  kill(signal?: NodeJS.Signals): boolean {
    this.killed.push(signal ?? "SIGTERM");
    return true;
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null) {
    this.emit("exit", code, signal);
  }
}

function fakeSignals() {
  const handlers = new Map<string, () => void>();
  return {
    handlers,
    signals: {
      on: (name: string, fn: () => void) => void handlers.set(name, fn),
      off: (name: string) => void handlers.delete(name),
    },
  };
}

async function setup(respond?: Parameters<typeof harness>[0]) {
  const h = await harness(respond ?? ((call) => call.path.endsWith("/claim")
    ? json(claimBody({ task: { state: "claimed", leaseUntil: "x", epoch: 3, needs: [] } }))
    : json({ task: { state: "claimed", needs: [] } })));
  const child = new FakeChild();
  const spawn = vi.fn(() => child);
  const kill = vi.fn();
  const { handlers, signals } = fakeSignals();
  return { ...h, child, spawn, kill, handlers, deps: { ...h.deps, spawn, kill, signals } };
}

const started = (s: { spawn: ReturnType<typeof vi.fn> }) => vi.waitFor(() => expect(s.spawn).toHaveBeenCalledTimes(1));
const requests = (s: { calls: unknown[] }, count: number) => vi.waitFor(() => expect(s.calls).toHaveLength(count));
const settlePaths = (calls: Array<{ path: string }>) => calls.map((call) => call.path.split("/").at(-1));
const fakeTimers = () => vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });

// Fault detected: a task run by `tasks run` stays claimed after the command exits, its
// lease lapses mid-run, or Ctrl-C leaves it held until the lease expires.
describe("matrix board tasks run", () => {
  it("runs the command in its own process group with BOARD_TASK set and completes on exit 0", async () => {
    const s = await setup();
    const running = runBoardCli(["tasks", "run", "--ready", "build", "--", "pnpm", "test", "--run"], s.deps);
    await started(s);

    const [command, args, options] = s.spawn.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv; detached: boolean; stdio: unknown }];
    expect([command, args]).toEqual(["pnpm", ["test", "--run"]]);
    expect(options.env.BOARD_TASK).toBe(TASK_ID);
    expect(options.detached).toBe(true);
    expect(options.stdio).toBe("inherit");
    expect(JSON.stringify(options.env)).not.toContain(TOKEN);

    s.child.exit(0);
    expect(await running).toBe(0);
    expect(settlePaths(s.calls)).toEqual(["claim", "complete"]);
    expect(s.calls[1]!.body).toEqual({ epoch: 3, token: TOKEN });
    expect(s.handlers.size).toBe(0);
  });

  it("fails the task with the exit code on a non-zero exit", async () => {
    const s = await setup();
    const running = runBoardCli(["tasks", "run", "--ready", "build", "--", "false"], s.deps);
    await started(s);
    s.child.exit(3);
    expect(await running).toBe(1);
    expect(s.calls[1]).toMatchObject({ path: `/api/board/tasks/${TASK_ID}/fail`, body: { epoch: 3, token: TOKEN, reason: "exit 3" } });
  });

  it("renews every third of the lease while the command runs", async () => {
    fakeTimers();
    const s = await setup();
    const running = runBoardCli(["tasks", "run", "--ready", "build", "--lease", "3m", "--", "sleep", "1000"], s.deps);
    await started(s);

    await vi.advanceTimersByTimeAsync(60_000);
    await requests(s, 2);
    await vi.advanceTimersByTimeAsync(60_000);
    await requests(s, 3);
    expect(settlePaths(s.calls)).toEqual(["claim", "renew", "renew"]);
    expect(s.calls[1]!.body).toEqual({ epoch: 3, token: TOKEN, leaseSeconds: 180 });

    s.child.exit(0);
    expect(await running).toBe(0);
    await vi.advanceTimersByTimeAsync(200_000);
    expect(settlePaths(s.calls)).toEqual(["claim", "renew", "renew", "complete"]);
  });

  // Fault detected (review): a renew reply that landed after the command exited armed a
  // new deadline timer, keeping the CLI alive for most of a lease after it finished.
  it("does not arm a deadline when a renew reply arrives after the command exited", async () => {
    fakeTimers();
    let releaseRenew: (response: Response) => void = () => undefined;
    const s = await setup((call) => {
      if (call.path.endsWith("/claim")) return json(claimBody({ task: { state: "claimed", leaseUntil: "x", epoch: 3, needs: [] } }));
      if (call.path.endsWith("/renew")) return new Promise<Response>((resolve) => { releaseRenew = resolve; });
      return json({ task: { state: "completed", needs: [] } });
    });
    const running = runBoardCli(["tasks", "run", "--ready", "build", "--lease", "3m", "--", "sleep", "1000"], s.deps);
    await started(s);
    await vi.advanceTimersByTimeAsync(60_000);
    await requests(s, 2);
    s.child.exit(0);
    expect(await running).toBe(0);
    releaseRenew(json({ task: { state: "claimed", needs: [] } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  // Fault detected (review): Ctrl-C stopped only the direct child, so a shell's
  // grandchildren kept working on a task that had been released.
  it("stops the whole process group, escalates to SIGKILL, then releases and exits 130 on SIGINT", async () => {
    fakeTimers();
    const s = await setup();
    const running = runBoardCli(["tasks", "run", "--ready", "build", "--", "sh", "-c", "sleep 1000"], s.deps);
    await started(s);

    s.handlers.get("SIGINT")!();
    expect(s.kill).toHaveBeenCalledWith(-PID, "SIGTERM");
    await vi.advanceTimersByTimeAsync(4_000);
    expect(s.kill).not.toHaveBeenCalledWith(-PID, "SIGKILL");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(s.kill).toHaveBeenCalledWith(-PID, "SIGKILL");
    expect(settlePaths(s.calls)).toEqual(["claim"]);
    s.child.exit(null, "SIGKILL");

    expect(await running).toBe(130);
    expect(settlePaths(s.calls)).toEqual(["claim", "release"]);
    expect(s.calls[1]!.body).toEqual({ epoch: 3, token: TOKEN });
  });

  it("stops the process group and exits 1 when the claim is lost during a renew", async () => {
    fakeTimers();
    const s = await setup((call) => call.path.endsWith("/claim")
      ? json(claimBody())
      : boardError("claim_lost", 409, "Your claim on this task has lapsed."));
    const running = runBoardCli(["tasks", "run", "--ready", "build", "--", "sleep", "1000"], s.deps);
    await started(s);
    await vi.advanceTimersByTimeAsync(100_000);
    await vi.waitFor(() => expect(s.kill).toHaveBeenCalledWith(-PID, "SIGTERM"));
    s.child.exit(null, "SIGTERM");
    expect(await running).toBe(1);
    expect(settlePaths(s.calls)).toEqual(["claim", "renew"]);
  });

  // Fault detected (review): with the gateway unreachable every renew failed softly and
  // the command kept working long after the lease had passed to someone else.
  it("stops the command before the last confirmed lease runs out when renewals keep failing", async () => {
    fakeTimers();
    const s = await setup((call) => {
      if (call.path.endsWith("/claim")) return json(claimBody());
      throw new TypeError("fetch failed");
    });
    const running = runBoardCli(["tasks", "run", "--ready", "build", "--json", "--", "sleep", "1000"], s.deps);
    await started(s);

    await vi.advanceTimersByTimeAsync(200_000);
    await requests(s, 3);
    expect(s.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(99_000);
    await vi.waitFor(() => expect(s.kill).toHaveBeenCalledWith(-PID, "SIGTERM"));
    s.child.exit(null, "SIGTERM");

    expect(await running).toBe(1);
    expect(s.out).toHaveLength(1);
    expect(JSON.parse(s.out[0]!)).toMatchObject({ ok: false, reason: "lease_expired", taskId: TASK_ID, outcome: "lease_expired" });
  });

  // Fault detected (review): another pane's `tasks complete` for the same task erased or
  // reused the file `tasks run` depended on.
  it("uses its own in-memory claim and never reads or writes the shared claim file", async () => {
    const s = await setup();
    const dir = join(s.home, ".matrixos", "board", "claims", "default", "default");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const planted = JSON.stringify({ taskId: TASK_ID, epoch: 9, token: "d".repeat(64), board: "General", claimedAt: "x" });
    await writeFile(join(dir, `${TASK_ID}.json`), planted, { mode: 0o600 });

    const running = runBoardCli(["tasks", "run", "--ready", "build", "--", "true"], s.deps);
    await started(s);
    s.child.exit(0);
    expect(await running).toBe(0);

    expect(s.calls[1]!.body).toEqual({ epoch: 3, token: TOKEN });
    expect(await readdir(dir)).toEqual([`${TASK_ID}.json`]);
    expect(await readFile(join(dir, `${TASK_ID}.json`), "utf8")).toBe(planted);
  });

  // Fault detected (review): `tasks run --json` mixed the command's output into the JSON
  // document on stdout.
  it("sends the command's stdout to stderr under --json and prints one document after settling", async () => {
    const s = await setup();
    const running = runBoardCli(["tasks", "run", "--ready", "build", "--json", "--", "make"], s.deps);
    await started(s);
    const options = (s.spawn.mock.calls[0] as unknown as unknown[])[2] as { stdio: unknown };
    expect(options.stdio).toEqual(["inherit", 2, "inherit"]);
    expect(s.out).toEqual([]);
    s.child.exit(0);
    expect(await running).toBe(0);
    expect(s.out).toHaveLength(1);
    expect(JSON.parse(s.out[0]!)).toEqual({ v: 1, ok: true, data: { taskId: TASK_ID, outcome: "completed", exitCode: 0 } });

    const failing = await setup();
    const second = runBoardCli(["tasks", "run", "--ready", "build", "--json", "--", "make"], failing.deps);
    await started(failing);
    failing.child.exit(3);
    expect(await second).toBe(1);
    expect(failing.out).toHaveLength(1);
    expect(JSON.parse(failing.out[0]!)).toMatchObject({ ok: false, reason: "command_failed", taskId: TASK_ID, outcome: "failed", exitCode: 3 });
  });

  it("exits 2 without a command and 1 when nothing is ready", async () => {
    const s = await setup(() => boardError("nothing_ready", 404, "No task is ready to claim."));
    expect(await runBoardCli(["tasks", "run", "--ready", "build"], s.deps)).toBe(2);
    expect(await runBoardCli(["tasks", "run", "--", "true"], s.deps)).toBe(2);
    expect(await runBoardCli(["tasks", "run", "--ready", "build", "--", "true"], s.deps)).toBe(1);
    expect(s.spawn).not.toHaveBeenCalled();
  });
});
