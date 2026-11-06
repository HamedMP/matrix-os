import { chmod, lstat, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, connect, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { startBotCommandServer, parseScopeRuntimeBotWorkerArguments } from "../../packages/scope-runtime/src/worker-bot.js";
import { startCommandServer, createSingleUseCommandSocketSlot, parseScopeRuntimeWorkerArguments } from "../../packages/scope-runtime/src/worker.js";
import { commandPublicationFixture, portablePublicationPin } from "../helpers/command-ipc-fixture.js";
import { createUnixSocketTempDir } from "../helpers/unix-socket-temp.js";
import type { CommandPublicationDependencies } from "../../packages/scope-runtime/src/command-socket-publication.js";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const handle = "runtime_" + "a".repeat(32), scope = "scope_" + "b".repeat(32);
async function start(kind: string, path: string, publication: CommandPublicationDependencies) {
  publication = { ...await commandPublicationFixture(path), ...publication };
  if (kind === "bot") return startBotCommandServer({ socketPath: path, publication,
    invocation: parseScopeRuntimeBotWorkerArguments([handle, scope, "bot_agent", "matrix-bot", "1.0.0", "1"]), handler: { handle: vi.fn(async () => ({})) } });
  const slot = createSingleUseCommandSocketSlot<Socket>();
  const result = await startCommandServer(parseScopeRuntimeWorkerArguments([handle, scope, "chat_ai", "claude-code", "2.1.240", "1"]), slot, path, publication);
  return { server: result.server, async close() { slot.destroyActive(); await new Promise<void>(resolve => result.server.close(() => resolve())); await result.removeOwnedSocket(); } };
}
async function fixture() {
  const root = await createUnixSocketTempDir(); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "worker.sock"), publication = await commandPublicationFixture(path);
  return { root, path, publication };
}
it.each(["chat", "bot"])("publishes %s before returning readiness and removes only its own socket", async kind => {
  const { root, path, publication } = await fixture(); const worker = await start(kind, path, publication); cleanup.push(() => worker.close());
  expect((await lstat(path)).mode & 0o7777).toBe(0o620);
  expect((await lstat(path)).nlink).toBe(1);
  const stage = (await readdir(root)).find(name => name.startsWith(".w-"))!;
  expect((await lstat(join(root, stage))).mode & 0o7777).toBe(0o2700);
  expect(await readdir(join(root, stage))).toEqual([]);
  await rename(path, path + ".original"); await writeFile(path, "replacement");
  await worker.close(); expect(await readFile(path, "utf8")).toBe("replacement");
  expect((await readdir(root)).some(name => name.startsWith(".w-"))).toBe(false);
});
it.each(["chat", "bot"])("withholds %s readiness on pinned chmod failure and closes listener and pin", async kind => {
  const { path } = await fixture(); let closed = 0;
  await expect(start(kind, path, { async pin(p) { const pin = await portablePublicationPin(p);
    return { ...pin, path: pin.path + ".absent", async close() { closed++; await pin.close(); } }; } })).rejects.toMatchObject({ code: "ENOENT" });
  expect(closed).toBe(1); await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
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

it.each(["file", "socket", "symlink"])("preserves an existing final %s and cleans only owned staging on exclusive-link failure", async kind => {
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
  expect((await readdir(root)).some(name => name.startsWith(".w-"))).toBe(false);
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
