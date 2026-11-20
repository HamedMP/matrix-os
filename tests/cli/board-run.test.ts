import { EventEmitter } from "node:events";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runBoardCli } from "../../packages/sync-client/src/cli/commands/board.js";
import type { BoardChild } from "../../packages/sync-client/src/cli/board-cli-support.js";
import { boardError, claimBody, cleanupHomes, harness, json, TASK_ID, TOKEN } from "./board-harness.js";

afterEach(async () => {
  vi.useRealTimers();
  await cleanupHomes();
});

class FakeChild extends EventEmitter implements BoardChild {
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
  const { handlers, signals } = fakeSignals();
  return { ...h, child, spawn, handlers, deps: { ...h.deps, spawn, signals } };
}

const started = (s: { spawn: ReturnType<typeof vi.fn> }) => vi.waitFor(() => expect(s.spawn).toHaveBeenCalledTimes(1));
const requests = (s: { calls: unknown[] }, count: number) => vi.waitFor(() => expect(s.calls).toHaveLength(count));

const settlePaths = (calls: Array<{ path: string }>) => calls.map((call) => call.path.split("/").at(-1));

// Fault detected: a task run by `tasks run` stays claimed after the command exits, its
// lease lapses mid-run, or Ctrl-C leaves it held until the lease expires.
describe("matrix board tasks run", () => {
  it("runs the command with BOARD_TASK set and completes on exit 0", async () => {
    const s = await setup();
    const running = runBoardCli(["tasks", "run", "--ready", "build", "--", "pnpm", "test", "--run"], s.deps);
    await started(s);

    expect(s.spawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = s.spawn.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }];
    expect([command, args]).toEqual(["pnpm", ["test", "--run"]]);
    expect(options.env.BOARD_TASK).toBe(TASK_ID);
    expect(JSON.stringify(options.env)).not.toContain(TOKEN);

    s.child.exit(0);
    expect(await running).toBe(0);
    expect(settlePaths(s.calls)).toEqual(["claim", "complete"]);
    expect(s.calls[1]!.body).toEqual({ epoch: 3, token: TOKEN });
    expect(await readdir(join(s.home, ".matrixos", "board", "claims", "default"))).toEqual([]);
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
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
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

  it("releases the task and exits 130 on SIGINT", async () => {
    const s = await setup();
    const running = runBoardCli(["tasks", "run", "--ready", "build", "--", "sleep", "1000"], s.deps);
    await started(s);

    s.handlers.get("SIGINT")!();
    expect(s.child.killed).toEqual(["SIGINT"]);
    s.child.exit(null, "SIGINT");

    expect(await running).toBe(130);
    expect(settlePaths(s.calls)).toEqual(["claim", "release"]);
    expect(s.calls[1]!.body).toEqual({ epoch: 3, token: TOKEN });
  });

  it("stops the command and exits 1 when the claim is lost during a renew", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    const s = await setup((call) => call.path.endsWith("/claim")
      ? json(claimBody())
      : boardError("claim_lost", 409, "Your claim on this task has lapsed."));
    const running = runBoardCli(["tasks", "run", "--ready", "build", "--", "sleep", "1000"], s.deps);
    await started(s);
    await vi.advanceTimersByTimeAsync(100_000);
    await vi.waitFor(() => expect(s.child.killed).toEqual(["SIGTERM"]));
    s.child.exit(null, "SIGTERM");
    expect(await running).toBe(1);
    expect(settlePaths(s.calls)).toEqual(["claim", "renew"]);
  });

  it("exits 2 without a command and 1 when nothing is ready", async () => {
    const s = await setup(() => boardError("nothing_ready", 404, "No task is ready to claim."));
    expect(await runBoardCli(["tasks", "run", "--ready", "build"], s.deps)).toBe(2);
    expect(await runBoardCli(["tasks", "run", "--", "true"], s.deps)).toBe(2);
    expect(await runBoardCli(["tasks", "run", "--ready", "build", "--", "true"], s.deps)).toBe(1);
    expect(s.spawn).not.toHaveBeenCalled();
  });
});
