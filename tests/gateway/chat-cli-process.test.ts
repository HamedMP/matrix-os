import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCanonicalCli, type CanonicalCliProcess } from "../../packages/gateway/src/chat/cli-process.js";

class FakeStream extends EventEmitter {
  override on(event: "data", listener: (chunk: Buffer) => void): this {
    return super.on(event, listener);
  }
}

class StubbornCli extends EventEmitter implements CanonicalCliProcess {
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  readonly signals: NodeJS.Signals[] = [];

  override once(event: "exit" | "error", listener: (...args: never[]) => void): this {
    return super.once(event, listener);
  }

  kill(signal: NodeJS.Signals): void {
    this.signals.push(signal);
    if (signal === "SIGKILL") this.emit("exit", null, "SIGKILL");
  }
}

describe("canonical provider CLI lifecycle", () => {
  afterEach(() => vi.useRealTimers());

  it("escalates a timed-out provider from SIGTERM to SIGKILL before settling", async () => {
    vi.useFakeTimers();
    const child = new StubbornCli();
    const run = runCanonicalCli({
      command: "provider",
      args: [],
      cwd: "/tmp",
      env: {},
      signal: new AbortController().signal,
      timeoutMs: 10,
      maxStdoutBytes: 1024,
      spawnFn: () => child,
      onStdout: vi.fn(),
    });
    const rejection = run.then(
      () => new Error("expected provider CLI Run to reject"),
      (error: unknown) => error,
    );

    await vi.advanceTimersByTimeAsync(10);
    expect(child.signals).toEqual(["SIGTERM"]);
    child.stdout.emit("data", Buffer.from("late output"));
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(rejection).resolves.toMatchObject({ message: "Provider CLI Run timed out" });
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("does not deliver provider output after termination starts", async () => {
    vi.useFakeTimers();
    const child = new StubbornCli();
    const onStdout = vi.fn();
    const run = runCanonicalCli({
      command: "provider",
      args: [],
      cwd: "/tmp",
      env: {},
      signal: new AbortController().signal,
      timeoutMs: 10,
      maxStdoutBytes: 1024,
      spawnFn: () => child,
      onStdout,
    });
    const rejection = run.then(
      () => new Error("expected provider CLI Run to reject"),
      (error: unknown) => error,
    );

    await vi.advanceTimersByTimeAsync(10);
    child.stdout.emit("data", Buffer.from("late output"));
    expect(onStdout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(rejection).resolves.toMatchObject({ message: "Provider CLI Run timed out" });
  });

  it("bounds private stderr evidence and preserves typed exit diagnostics", async () => {
    const child = new StubbornCli();
    const stderrChunks: Buffer[] = [];
    const run = runCanonicalCli({
      command: "provider",
      args: [],
      cwd: "/tmp",
      env: {},
      signal: new AbortController().signal,
      timeoutMs: 10_000,
      maxStdoutBytes: 1024,
      maxStderrBytes: 8,
      spawnFn: () => child,
      onStdout: vi.fn(),
      onStderr: (chunk) => stderrChunks.push(chunk),
    });

    child.stderr.emit("data", Buffer.from("123456"));
    child.stderr.emit("data", Buffer.from("7890-secret"));
    child.emit("exit", 17, null);

    await expect(run).rejects.toMatchObject({
      name: "CanonicalCliError",
      kind: "exit",
      exitCode: 17,
      signal: null,
    });
    expect(Buffer.concat(stderrChunks).toString("utf8")).toBe("12345678");
  });
});
