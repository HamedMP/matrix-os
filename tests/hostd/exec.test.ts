import { describe, expect, it } from "vitest";
import { createExec, ExecError, run } from "../../packages/hostd/src/exec.js";

const exec = createExec();
const signal = () => AbortSignal.timeout(5_000);

describe("host exec", () => {
  it("runs argv without a shell and captures output and exit code", async () => {
    await expect(exec(["sh", "-c", "echo out; echo err >&2; exit 3"], { signal: signal() })).resolves.toEqual({
      code: 3,
      stdout: "out\n",
      stderr: "err\n",
    });
    await expect(exec(["echo", "$HOME;", "rm"], { signal: signal() })).resolves.toMatchObject({ stdout: "$HOME; rm\n" });
  });

  it("caps captured output at 256 KiB", async () => {
    const result = await exec(["head", "-c", String(1024 * 1024), "/dev/zero"], { signal: signal() });
    expect(result.stdout.length).toBe(256 * 1024);
  });

  it("reports a missing program as spawn_failed", async () => {
    await expect(exec(["/nonexistent/program"], { signal: signal() })).rejects.toMatchObject({
      name: "ExecError",
      code: "spawn_failed",
      program: "/nonexistent/program",
    });
  });

  it("reports an aborted or already-aborted command as timeout", async () => {
    await expect(exec(["sleep", "5"], { signal: AbortSignal.timeout(50) })).rejects.toMatchObject({ code: "timeout" });
    const aborted = AbortSignal.abort();
    await expect(exec(["true"], { signal: aborted })).rejects.toMatchObject({ code: "timeout" });
  });

  it("run throws on a non-zero exit, keeping stderr off the message", async () => {
    await expect(run(exec, ["true"], signal())).resolves.toMatchObject({ code: 0 });
    const error = await run(exec, ["sh", "-c", "echo /secret/path >&2; exit 4"], signal()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExecError);
    expect(error).toMatchObject({ code: "failed", exitCode: 4, stderr: "/secret/path\n" });
    expect((error as Error).message).toBe("sh exited with 4");
  });
});
