import type { CommandSocketTrust } from "../../packages/scope-runtime/src/command-ipc-policy.js";
import { commandIdentityFixture } from "../helpers/command-ipc-fixture.js";
import { createServer } from "node:net";
import { join } from "node:path";
import { mkdir, rename, rm, symlink } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createUnixSocketTempDir } from "../helpers/unix-socket-temp.js";
import { portableCommandSocketPin } from "../helpers/portable-command-socket-pin.js";
import { createSystemdScopeRuntimeLauncher } from "../../packages/scope-runtime/src/systemd-launcher.js";
const interleaving = vi.hoisted(() => ({ leaf: "", swap: undefined as (() => Promise<void>) | undefined }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, async lstat(path: string, ...rest: unknown[]) {
    const value = await actual.lstat(path, ...rest as []);
    if (path === interleaving.leaf && interleaving.swap) { const swap = interleaving.swap; interleaving.swap = undefined; await swap(); }
    return value;
  } };
});
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { interleaving.leaf = ""; interleaving.swap = undefined; for (const close of cleanup.splice(0).reverse()) await close(); });

it.each(["chat", "bot"])("pins %s dispatch across the controlled validation-to-connect worker-leaf swap", async (kind) => {
  const root = await createUnixSocketTempDir(); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const handle = `runtime_${"a".repeat(32)}`, commandDirectory = join(root, "runtimes", "a".repeat(32), "command");
  await mkdir(commandDirectory, { recursive: true });
  const socketPath = join(commandDirectory, "worker.sock"), peerPath = join(root, "peer.sock");
  let peerFrames = 0;
  for (const [path, owner] of [[socketPath, "owner"], [peerPath, "peer"]]) {
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      let frame = ""; socket.setEncoding("utf8"); socket.on("data", (chunk) => { frame += chunk; });
      socket.once("end", () => {
        JSON.parse(frame); if (owner === "peer") peerFrames++;
        socket.end(`${JSON.stringify(kind === "bot" ? { version: 1, ok: true, reply: { namespace: owner } } : {
          version: 1, type: "runtime.chat.result", requestId: "018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1", ok: true,
          runtimeHandle: handle, executionGeneration: "7", text: owner })}\n`);
      });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  }
  const swap = async () => { await rename(socketPath, join(commandDirectory, "original.sock")); await symlink(peerPath, socketPath); };
  interleaving.leaf = socketPath; interleaving.swap = swap;
  let pinsClosed = 0;
  const launcher = createSystemdScopeRuntimeLauncher({ ...commandIdentityFixture(root), stateRoot: root, sdkDirectory: root, nativeDirectory: root,
    workerFile: join(root, "unused"), brokerSocket: join(root, "unused.sock"),
    async pinCommandSocket(path: string) {
      // Suppress the legacy lstat hook while making the fixture's immutable hardlink pin.
      interleaving.leaf = "";
      const pinned = await portableCommandSocketPin(path);
      const pending = interleaving.swap; interleaving.swap = undefined; await pending?.();
      return { path: pinned.path, async close() { pinsClosed++; await pinned.close(); } };
    },
  });
  const result = kind === "bot"
    ? await launcher.runBot!({ runtimeHandle: handle, executionGeneration: "7", command: { version: 1, kind: "bot.cancel", runId: "run_test" } })
    : await launcher.runChat({ runtimeHandle: handle, executionGeneration: "7", model: "test", prompt: "private-owner-command" });
  expect(result).toEqual(kind === "bot" ? { version: 1, ok: true, reply: { namespace: "owner" } } : { text: "owner" });
  expect(peerFrames).toBe(0); expect(interleaving.swap).toBeUndefined(); expect(pinsClosed).toBe(1);
});

it.each(["malformed", "cancelled", "oversized"])("releases a pinned command socket after %s dispatch", async (failure) => {
  const root = await createUnixSocketTempDir(); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const handle = `runtime_${"a".repeat(32)}`, directory = join(root, "runtimes", "a".repeat(32), "command");
  await mkdir(directory, { recursive: true });
  const server = createServer({ allowHalfOpen: true }, (socket) => { socket.resume(); socket.once("end", () => socket.end(failure === "cancelled" ? undefined : "invalid-json\n")); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(join(directory, "worker.sock"), resolve); });
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  let closed = 0, pinnedPath = "";
  const launcher = createSystemdScopeRuntimeLauncher({ ...commandIdentityFixture(root), stateRoot: root, sdkDirectory: root, nativeDirectory: root,
    workerFile: join(root, "unused"), brokerSocket: join(root, "unused.sock"),
    async pinCommandSocket(path: string) {
      const pin = await portableCommandSocketPin(path); pinnedPath = pin.path;
      return { path: pin.path, async close() { closed++; await pin.close(); } };
    } });
  const signal = AbortSignal.abort();
  const result = failure === "cancelled"
    ? launcher.runBot!({ runtimeHandle: handle, executionGeneration: "7", command: { version: 1, kind: "bot.cancel", runId: "run_test" }, signal })
    : launcher.runChat({ runtimeHandle: handle, executionGeneration: "7", model: "test", prompt: failure === "oversized" ? "x".repeat(200_000) : "test" });
  await expect(result).rejects.toThrow();
  expect(closed).toBe(1);
  await expect(import("node:fs/promises").then(({ lstat }) => lstat(pinnedPath))).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["chat", "bot", "managed-pi"])("rejects old %s provenance before pinning and binds current generation to identity", async kind => {
  const { writeFile } = await import("node:fs/promises");
  const { runtimeProfileIdentity } = await import("../../packages/scope-runtime/src/bot-profile.js");
  const root = await createUnixSocketTempDir(); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const fixtureIdentity = commandIdentityFixture(root), handle = "runtime_" + "a".repeat(32);
  const runtimeRoot = join(root, "runtimes", "a".repeat(32)); await mkdir(join(runtimeRoot, "command"), { recursive: true });
  const profile = runtimeProfileIdentity(kind === "chat" ? undefined : kind === "bot" ? "scope-runtime-bot-v1" : "scope-runtime-managed-pi-v1");
  const provenance = { version: 1, runtimeHandle: handle, ...profile, workload: kind === "chat" ? "chat_ai" : "bot_agent",
    adapterId: kind === "chat" ? "claude-code" : "matrix-bot", harnessVersion: kind === "chat" ? "2.1.240" : "1.0.0", executionGeneration: "7" };
  const pin = vi.fn(async (_path: string, _trust: CommandSocketTrust) => { throw new Error("verified pin reached"); });
  const manager = createSystemdScopeRuntimeLauncher({ ...fixtureIdentity, stateRoot: root, sdkDirectory: root, nativeDirectory: root,
    workerFile: join(root, "unused"), brokerSocket: join(root, "unused.sock"), pinCommandSocket: pin,
    async resolveCommandTrust(binding) {
      expect(binding.unit).toBe(`matrix-scope-runtime-${"a".repeat(32)}.service`);
      expect(binding.root).toBe(join(runtimeRoot, "root"));
      await binding.validateProvenance(); return fixtureIdentity.resolveCommandTrust(binding);
    } });
  const dispatch = (generation = "7") => kind === "chat"
    ? manager.runChat({ runtimeHandle: handle, executionGeneration: generation, model: "test", prompt: "test" })
    : manager.runBot!({ runtimeHandle: handle, executionGeneration: generation, command: { version: 1, kind: "bot.cancel", runId: "run_test" } });
  await writeFile(join(runtimeRoot, "provenance.json"), JSON.stringify({ ...provenance, profileVersion: profile.profileVersion - 1 }));
  await expect(dispatch()).rejects.toThrow("Unsafe command IPC provenance"); expect(pin).not.toHaveBeenCalled();
  await writeFile(join(runtimeRoot, "provenance.json"), JSON.stringify(provenance));
  await expect(dispatch("8")).rejects.toThrow("Unsafe command IPC provenance"); expect(pin).not.toHaveBeenCalled();
  await expect(dispatch()).rejects.toThrow("verified pin reached"); expect(pin).toHaveBeenCalledOnce();
  expect(pin.mock.calls[0]![1]).toEqual({ uid: process.getuid!(), gid: process.getgid!(), workloadUid: process.getuid!() });
});
