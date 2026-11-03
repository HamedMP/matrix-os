import { EventEmitter } from "node:events";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { disallowNativeCronCreate, resolveClaudeNativeProtocol } from "../../packages/gateway/src/chat/claude-native-protocol.js";
import type { CanonicalCliSpawn } from "../../packages/gateway/src/chat/cli-process.js";

const scope = { command: process.execPath, cwd: process.cwd(), env: { PATH: process.env.PATH! }, signal: new AbortController().signal };
function child() {
  const c = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(() => {
    queueMicrotask(() => { c.emit("exit", null, "SIGTERM"); c.emit("close"); });
  }) });
  return c;
}
it.each(["2.1.317 (Claude Code)\n", "2.1.318 (Claude Code)\n", "unknown\n"])("qualifies only the exact selected executable version: %s", async output => {
  const c = child(); const spawnFn = vi.fn<CanonicalCliSpawn>(() => {
    queueMicrotask(() => { c.stdout.emit("data", Buffer.from(output)); c.emit("exit", 0, null); c.emit("close"); }); return c;
  });
  const result = await resolveClaudeNativeProtocol({ ...scope, spawnFn });
  expect(result).toEqual({ command: process.execPath, qualified: output.startsWith("2.1.317 ") });
  expect(spawnFn).toHaveBeenCalledWith(process.execPath, ["--version"], expect.objectContaining({ cwd: scope.cwd, env: scope.env }));
});
it("waits for the aborted version child to close and never reports an ordinary fallback", async () => {
  const c = child(); const controller = new AbortController();
  const pending = resolveClaudeNativeProtocol({ ...scope, signal: controller.signal, spawnFn: () => c });
  await vi.waitFor(() => expect(c.listenerCount("exit")).toBe(1)); controller.abort();
  await expect(pending).rejects.toMatchObject({ kind: "aborted" }); expect(c.kill).toHaveBeenCalledWith("SIGTERM");
});
it("pins a bare command through exactly the supplied launch PATH", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-version-"));
  try {
    const selected = join(directory, "claude"); await symlink(process.execPath, selected);
    const c = child(); const spawnFn = vi.fn<CanonicalCliSpawn>(() => {
      queueMicrotask(() => { c.stdout.emit("data", Buffer.from("2.1.317 (Claude Code)\n")); c.emit("exit", 0, null); c.emit("close"); }); return c;
    });
    await expect(resolveClaudeNativeProtocol({ ...scope, command: "claude", env: { PATH: directory }, spawnFn })).resolves.toEqual({ command: selected, qualified: true });
    expect(spawnFn.mock.calls[0]![0]).toBe(selected);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
it("never qualifies an unpinned command without an explicit launch PATH", async () => {
  const c = child();
  await expect(resolveClaudeNativeProtocol({ ...scope, command: "claude", env: {}, spawnFn: () => {
    queueMicrotask(() => { c.stdout.emit("data", Buffer.from("2.1.317 (Claude Code)\n")); c.emit("exit", 0, null); c.emit("close"); }); return c;
  } })).resolves.toEqual({ command: "claude", qualified: false });
});
it("never permits fallback when physical version child cleanup is unconfirmed", async () => {
  vi.useFakeTimers();
  try {
    const c = child();
    const pending = resolveClaudeNativeProtocol({ ...scope, spawnFn: () => c });
    const check = expect(pending).rejects.toHaveProperty("name", "ClaudeNativeProbeCleanupError");
    for (let index = 0; index < 10; index++) await Promise.resolve();
    c.emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(1501); await check;
  } finally { vi.useRealTimers(); }
});
it("treats a failed version query as unqualified only after actual close", async () => {
  const c = child(); let settled = false;
  const pending = resolveClaudeNativeProtocol({ ...scope, spawnFn: () => c }).then(value => { settled = true; return value; });
  await vi.waitFor(() => expect(c.listenerCount("exit")).toBe(1)); c.emit("exit", 1, null);
  await Promise.resolve(); expect(settled).toBe(false); c.emit("close");
  await expect(pending).resolves.toEqual({ command: process.execPath, qualified: false });
});
it("merges CronCreate into existing denied tools without duplicate flags or losing restrictions", () => {
  expect(disallowNativeCronCreate(["--disallowedTools", "Bash,Write", "Edit", "--model", "haiku"])).toEqual([
    "--disallowedTools", "Bash,Write", "Edit", "CronCreate", "--model", "haiku",
  ]);
  expect(disallowNativeCronCreate(["--disallowedTools=Bash,CronCreate", "--disallowedTools", "Write"])).toEqual([
    "--disallowedTools", "Bash,CronCreate", "Write", "CronCreate",
  ]);
});
