import { spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { hostConnection, startControls } from "../../scripts/ops/devstack-native/controls.mjs";
import { createJournal } from "../../scripts/ops/devstack-native/receipt.mjs";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const base = await mkdtemp("/tmp/nct-");
  cleanup.push(() => rm(base, { recursive: true, force: true }));
  const owned = [join(base, "a"), join(base, "b")];
  return { base, owned, config: { appRoot: join(base, "app") } };
}
async function listener(path: string) {
  const observed = { connections: 0 }, sockets = new Set<Socket>();
  const server = createServer(socket => {
    observed.connections++; sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => sockets.delete(socket)); socket.end();
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return observed;
}
async function staleSocket(path: string) {
  // Kill an owned fixture process without libuv unlinking its real socket inode.
  const child = spawn(process.execPath, ["--input-type=module", "-e",
    "process.umask(0o022); const {createServer}=await import('node:net'); createServer().listen(process.argv[1],()=>console.log('ready'));", path],
  { stdio: ["ignore", "pipe", "pipe"] });
  try {
    const [chunk] = await once(child.stdout!, "data"); expect(chunk.toString()).toBe("ready\n");
  } finally {
    child.kill("SIGKILL"); await once(child, "close");
  }
  expect((await lstat(path)).isSocket()).toBe(true);
}

it("keeps a real stale foreign IPC inode as metadata without blocking owned Unix/TCP/file controls", async () => {
  const { base, owned, config } = await fixture();
  const observations = await Promise.all(owned.map(listener));
  const stale = join(base, "stale"), live = join(base, "foreign");
  await staleSocket(stale); const foreign = await listener(live), identity = await lstat(stale);
  const controls = await startControls(config, { sockets: {
    [stale]: { role: "legacy_ipc" }, [live]: { role: "peer_ipc" },
  } }, owned);
  try {
    // A removed metadata prerequisite or skipped owned positive fails these observations.
    expect(observations.map(value => value.connections)).toEqual([1, 1]);
    expect(foreign.connections).toBe(0);
    expect(controls.targets).toHaveLength(4);
    expect(controls.hostPositive).toMatchObject({ tcp: true, syntheticFilePresent: true });
    expect(controls.hostPositive.sockets.find(value => value.role === "legacy_ipc"))
      .toMatchObject({ connected: false, evidence: "metadata_only", inode: identity.ino, device: identity.dev });
    expect(controls.hostPositive.sockets.find(value => value.role === "peer_ipc"))
      .toMatchObject({ connected: false, evidence: "metadata_only" });
    expect((await lstat(controls.filePath)).mode & 0o777).toBe(0o600);
  } finally { await controls.close(); }
  expect((await readdir(base)).some(name => name.startsWith(".boundary-"))).toBe(false);
  expect((await lstat(stale)).ino).toBe(identity.ino);
});

it.each(["missing", "file"])("still fails foreign metadata prerequisites for %s", async fault => {
  const { base, owned, config } = await fixture(); await Promise.all(owned.map(listener));
  const path = join(base, "foreign"); if (fault === "file") await writeFile(path, "fixture");
  await expect(startControls(config, { sockets: { [path]: { role: "legacy_ipc" } } }, owned)).rejects.toThrow();
  expect((await readdir(base)).some(name => name.startsWith(".boundary-"))).toBe(false);
});

it.each([
  [0, "stale", "econnrefused"], [1, "stale", "econnrefused"],
  [0, "missing", "enoent"], [1, "missing", "enoent"],
  [0, "file", "not_socket"], [1, "file", "not_socket"],
] as const)("records bounded owned role/errno for disposable %s with %s metadata", async (index, fault, reason) => {
  const { base, owned, config } = await fixture();
  if (fault === "stale") await staleSocket(owned[index]);
  if (fault === "file") await writeFile(owned[index], "fixture");
  await listener(owned[1 - index]);
  const foreignPath = join(base, "foreign"), foreign = await listener(foreignPath);
  const journal = createJournal(), expected = `positive_control_owned_peer_command_${index}_${reason}`;
  await expect(journal.step("isolation", () => startControls(config,
    { sockets: { [foreignPath]: { role: "legacy_ipc" } } }, owned))).rejects.toThrow(expected);
  expect(journal.result().gates.isolation).toEqual({ state: "failed", code: expected });
  expect(JSON.stringify(journal.result())).not.toContain(base);
  expect(foreign.connections).toBe(0);
});

it("fails unknown connection errors with a fixed role and no raw path or errno", async () => {
  const journal = createJournal();
  await expect(journal.step("isolation", () => hostConnection({ path: "/" + "private".repeat(200) }, "owned_peer_command_0")))
    .rejects.toThrow("positive_control_owned_peer_command_0_unknown");
  expect(journal.result().gates.isolation).toEqual({ state: "failed", code: "positive_control_owned_peer_command_0_unknown" });
});

it("requires exactly two owned disposable controls and the legacy metadata prerequisite", async () => {
  const { base, owned, config } = await fixture();
  const path = join(base, "foreign"); await listener(path);
  await expect(startControls(config, { sockets: { [path]: { role: "legacy_ipc" } } }, []))
    .rejects.toThrow("owned_command_controls_missing");
  await Promise.all(owned.map(listener));
  await expect(startControls(config, { sockets: {} }, owned)).rejects.toThrow("required_legacy_endpoint_missing");
});

it("rejects duplicate owned targets instead of counting one listener twice", async () => {
  const { base, owned, config } = await fixture();
  const observed = await listener(owned[0]), path = join(base, "foreign"), foreign = await listener(path);
  await expect(startControls(config, { sockets: { [path]: { role: "legacy_ipc" } } }, [owned[0], owned[0]]))
    .rejects.toThrow("owned_command_controls_missing");
  expect(observed.connections).toBe(0); expect(foreign.connections).toBe(0);
});
