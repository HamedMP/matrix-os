import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { runCanonicalCli } from "../../packages/gateway/src/chat/cli-process.js";

it("lets a caller with bounded protocol frames consume more than a cumulative stdout budget", async () => {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(),
    kill: vi.fn(() => child.emit("exit", null, "SIGTERM")) });
  const chunks: string[] = [];
  const run = runCanonicalCli({ command: "fixture", args: [], cwd: "/safe", env: {},
    signal: new AbortController().signal, maxStdoutBytes: 32,
    stdoutLimitMode: "caller_bounded_frames", spawnFn: () => child,
    onStdout: chunk => chunks.push(chunk.toString()),
  });
  const outcome = run.then(() => "completed", () => "failed");
  for (let index = 0; index < 20; index++) child.stdout.emit("data", Buffer.from('{"type":"progress"}\n'));
  child.emit("exit", 0, null);
  expect(await outcome).toBe("completed");
  expect(chunks).toHaveLength(20);
  expect(child.kill).not.toHaveBeenCalled();
});
