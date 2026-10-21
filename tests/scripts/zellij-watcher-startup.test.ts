import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const smokeSource = readFileSync("scripts/smoke-zellij-watcher-sizing.mjs", "utf8");
const functionStart = smokeSource.indexOf("async function startDetachedSession() {");
const functionEnd = smokeSource.indexOf("\nasync function assertTerminalStaysAlive", functionStart);
if (functionStart < 0 || functionEnd < 0) throw new Error("Zellij startup test source boundary changed");
const startupSource = smokeSource.slice(functionStart, functionEnd);
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

function startupFixture(visibleOnPoll: number, exitCode: number) {
  let now = 0;
  let polls = 0;
  let onExit: (event: { exitCode: number }) => void = () => {
    throw new Error("Zellij exit listener was not registered");
  };
  const dispose = vi.fn();
  const kill = vi.fn();
  const spawn = vi.fn(() => ({
    onExit: (listener: typeof onExit) => { onExit = listener; },
    kill,
  }));
  const sessionExists = vi.fn(async () => {
    polls += 1;
    // Exit occurs while the first real session-list request is in flight.
    if (polls === 1) onExit({ exitCode });
    return polls >= visibleOnPoll;
  });
  const run = () => new AsyncFunction(
    "spawn", "answerHostQueries", "sessionExists", "Date", "setTimeout",
    "zellijBinary", "layoutPath", "sessionName", "homeDir", "isolatedEnv",
    `${startupSource}\nreturn startDetachedSession();`,
  )(
    spawn, () => ({ dispose }), sessionExists, { now: () => now },
    (resolveWait: () => void, milliseconds: number) => { now += milliseconds; resolveWait(); },
    "/synthetic/zellij", "/synthetic/layout.kdl", "synthetic-session", "/synthetic/home", {},
  );
  return { run, spawn, sessionExists, dispose, kill, elapsed: () => now };
}

describe("Zellij watcher smoke detached startup", () => {
  it("waits for session visibility after the background launcher exits successfully", async () => {
    const fixture = startupFixture(2, 0);
    await expect(fixture.run()).resolves.toBeUndefined();
    expect(fixture.sessionExists).toHaveBeenCalledTimes(2);
    expect(fixture.spawn).toHaveBeenCalledTimes(1);
    expect(fixture.elapsed()).toBe(50);
    expect(fixture.dispose).toHaveBeenCalledTimes(1);
    expect(fixture.kill).not.toHaveBeenCalled();
  });

  it("times out at the existing bound if a clean launcher exit never produces a session", async () => {
    const fixture = startupFixture(Number.POSITIVE_INFINITY, 0);
    await expect(fixture.run()).rejects.toThrow("detached Zellij startup timed out");
    expect(fixture.elapsed()).toBe(5_000);
    expect(fixture.sessionExists).toHaveBeenCalledTimes(100);
    expect(fixture.spawn).toHaveBeenCalledTimes(1);
    expect(fixture.dispose).toHaveBeenCalledTimes(1);
    expect(fixture.kill).toHaveBeenCalledTimes(1);
  });

  it("fails immediately when the background launcher exits unsuccessfully", async () => {
    const fixture = startupFixture(2, 7);
    await expect(fixture.run()).rejects.toThrow("detached Zellij startup exited with 7");
    expect(fixture.elapsed()).toBe(0);
    expect(fixture.sessionExists).toHaveBeenCalledTimes(1);
    expect(fixture.spawn).toHaveBeenCalledTimes(1);
    expect(fixture.dispose).toHaveBeenCalledTimes(1);
  });
});
