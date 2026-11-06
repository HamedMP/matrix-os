import { chmod, lstat, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, connect, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { startBotCommandServer, parseScopeRuntimeBotWorkerArguments } from "../../packages/scope-runtime/src/worker-bot.js";
import { startCommandServer, createSingleUseCommandSocketSlot, parseScopeRuntimeWorkerArguments } from "../../packages/scope-runtime/src/worker.js";
import { commandPublicationFixture, portablePublicationPin } from "../helpers/command-ipc-fixture.js";
import { createUnixSocketTempDir } from "../helpers/unix-socket-temp.js";
import type { CommandPublicationDependencies } from "../../packages/scope-runtime/src/command-socket-publication.js";
const interleaving = vi.hoisted(() => ({ path: "", swap: undefined as (() => Promise<void>) | undefined }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, async lstat(path: Parameters<typeof actual.lstat>[0]) {
    const entry = await actual.lstat(path);
    if (path === interleaving.path && interleaving.swap) {
      const swap = interleaving.swap; interleaving.swap = undefined; await swap();
    }
    return entry;
  } };
});
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { interleaving.path = ""; interleaving.swap = undefined; for (const close of cleanup.splice(0).reverse()) await close(); });
const handle = "runtime_" + "a".repeat(32), scope = "scope_" + "b".repeat(32);
async function start(kind: string, path: string, publication: CommandPublicationDependencies) {
  publication = { ...await commandPublicationFixture(path), ...publication };
  if (kind === "bot") return startBotCommandServer({ socketPath: path, publication,
    invocation: parseScopeRuntimeBotWorkerArguments([handle, scope, "bot_agent", "matrix-bot", "1.0.0", "1"]), handler: { handle: vi.fn(async () => ({})) } });
  const slot = createSingleUseCommandSocketSlot<Socket>();
  const result = await startCommandServer(parseScopeRuntimeWorkerArguments([handle, scope, "chat_ai", "claude-code", "2.1.240", "1"]), slot, path, publication);
  return { server: result, async close() { slot.destroyActive(); await new Promise<void>(resolve => result.close(() => resolve())); } };
}
async function fixture() {
  const root = await createUnixSocketTempDir(); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "worker.sock"), publication = await commandPublicationFixture(path);
  return { root, path, publication };
}
it.each(["chat", "bot"])("publishes %s before returning readiness and retains artifacts for quiesced supervisor cleanup", async kind => {
  const { root, path, publication } = await fixture(); const worker = await start(kind, path, publication); cleanup.push(() => worker.close());
  expect((await lstat(path)).mode & 0o7777).toBe(0o620);
  expect((await lstat(path)).nlink).toBe(1);
  const stage = (await readdir(root)).find(name => name.startsWith(".w-"))!;
  expect((await lstat(join(root, stage))).mode & 0o7777).toBe(0o2700);
  expect(await readdir(join(root, stage))).toEqual([]);
  await rename(path, path + ".original"); await writeFile(path, "replacement");
  await worker.close(); expect(await readFile(path, "utf8")).toBe("replacement");
  expect((await readdir(root)).some(name => name.startsWith(".w-"))).toBe(true);
});
it.each(["chat", "bot"])("withholds %s readiness on pinned chmod failure and closes listener and pin", async kind => {
  const { path } = await fixture(); let closed = 0;
  await expect(start(kind, path, { async pin(p) { const pin = await portablePublicationPin(p);
    return { ...pin, path: pin.path + ".absent", async close() { closed++; await pin.close(); } }; } })).rejects.toMatchObject({ code: "ENOENT" });
  expect(closed).toBe(1); expect((await lstat(path)).isSocket()).toBe(true);
  await expect(new Promise<void>((resolve, reject) => { const socket = connect(path); socket.once("error", reject); socket.once("connect", () => { socket.destroy(); resolve(); }); })).rejects.toMatchObject({ code: "ECONNREFUSED" });
});
it.each(["chat", "bot"])("never chmods or deletes a %s socket pathname replacement during publication", async kind => {
  const { path } = await fixture(); let closed = 0;
  await expect(start(kind, path, { async pin(p) {
    const pin = await portablePublicationPin(p); await rename(p, p + ".original"); await writeFile(p, "replacement"); await chmod(p, 0o644);
    return { ...pin, async close() { closed++; await pin.close(); } };
  } })).rejects.toThrow("Replaced");
  expect(closed).toBe(1); expect(await readFile(path, "utf8")).toBe("replacement");
  expect((await lstat(path)).mode & 0o7777).toBe(0o644);
  expect((await lstat(path + ".original")).mode & 0o7777).toBe(0o620);
});
it("preserves Chat's one-use slot after publishing without a readiness probe connection", async () => {
  const { path, publication } = await fixture(); const worker = await start("chat", path, publication); cleanup.push(() => worker.close());
  const first = connect(path); cleanup.push(async () => { first.destroy(); });
  await new Promise<void>((resolve, reject) => { first.once("connect", resolve); first.once("error", reject); });
  first.destroy(); await new Promise<void>(resolve => first.once("close", resolve));
  const second = connect(path); second.on("error", () => {});
  await new Promise<void>(resolve => second.once("close", resolve));
  expect(second.destroyed).toBe(true);
});

it.each(["file", "socket", "symlink"])("preserves an existing final %s and retains private staging on exclusive-link failure", async kind => {
  const { root, path, publication } = await fixture();
  if (kind === "file") await writeFile(path, "existing");
  else if (kind === "symlink") await symlink("missing", path);
  else {
    const server = createServer(); await new Promise<void>(resolve => server.listen(path, resolve));
    cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  }
  const before = await lstat(path);
  await expect(start("bot", path, publication)).rejects.toMatchObject({ code: "EEXIST" });
  expect((await lstat(path)).ino).toBe(before.ino);
  expect((await readdir(root)).some(name => name.startsWith(".w-"))).toBe(true);
});

it("rejects a replacement before pinning without chmodding that socket", async () => {
  const { path } = await fixture();
  await expect(start("chat", path, { async pin(p) {
    await rename(p, p + ".original");
    const replacement = createServer(); await new Promise<void>(resolve => replacement.listen(p, resolve));
    cleanup.push(() => new Promise<void>(resolve => replacement.close(() => resolve())));
    await chmod(p, 0o600);
    return portablePublicationPin(p);
  } })).rejects.toThrow("Unsafe");
  expect((await lstat(path)).mode & 0o7777).toBe(0o600);
});

it("allows inherited GID overflow inside PrivateUsers without requiring process group membership", async () => {
  const { path } = await fixture();
  const worker = await start("bot", path, { async pin(p) {
    const pinned = await portablePublicationPin(p);
    return { ...pinned, async parentStat() { return Object.assign(await pinned.parentStat(), { gid: 65534 }); },
      async socketStat() { return Object.assign(await pinned.socketStat(), { gid: 65534 }); } };
  } });
  cleanup.push(() => worker.close()); expect((await lstat(path)).mode & 0o7777).toBe(0o620);
});

it.each(["chat", "bot"])("never opens a %s close-time lstat-to-unlink replacement window", async kind => {
  const { path, publication } = await fixture(); const worker = await start(kind, path, publication);
  cleanup.push(() => worker.close());
  const replace = async () => { await rename(path, path + ".original"); await writeFile(path, "replacement-owner-data"); };
  interleaving.path = path; interleaving.swap = replace;
  await worker.close();
  // A safe implementation never inspects/removes the live canonical pathname.
  expect(interleaving.swap).toBe(replace);
  interleaving.swap = undefined; await replace();
  expect(await readFile(path, "utf8")).toBe("replacement-owner-data");
});
it("does not delete a staging-directory replacement between metadata read and rmdir", async () => {
  const { root, path, publication } = await fixture(); const worker = await start("bot", path, publication);
  cleanup.push(() => worker.close());
  const stage = join(root, (await readdir(root)).find(name => name.startsWith(".w-"))!);
  const replace = async () => { await rename(stage, stage + ".original"); await mkdir(stage); };
  interleaving.path = stage; interleaving.swap = replace;
  await worker.close();
  expect(interleaving.swap).toBe(replace);
  interleaving.swap = undefined; await replace();
  expect((await lstat(stage)).isDirectory()).toBe(true);
});
it("preserves a canonical replacement at the failure-cleanup lstat-to-unlink boundary", async () => {
  const { path } = await fixture();
  const replace = async () => { await rename(path, path + ".original"); await writeFile(path, "replacement-owner-data"); };
  await expect(start("bot", path, { async pin(p) {
    const pin = await portablePublicationPin(p);
    interleaving.path = path; interleaving.swap = replace;
    return { ...pin, path: pin.path + ".absent" };
  } })).rejects.toMatchObject({ code: "ENOENT" });
  expect(interleaving.swap).toBe(replace);
  interleaving.swap = undefined; await replace();
  expect(await readFile(path, "utf8")).toBe("replacement-owner-data");
});
