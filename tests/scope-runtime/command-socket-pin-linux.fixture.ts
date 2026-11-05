/** Standalone Linux qualification: bundle with esbuild, run with the target Node; no provider calls. */
import assert from "node:assert/strict";
import { createConnection, createServer, type Server } from "node:net";
import { link, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pinScopeRuntimeCommandSocket } from "../../packages/scope-runtime/src/command-socket-pin.js";

assert.equal(process.platform, "linux", "This qualification must execute on Linux");
const root = await mkdtemp(join(await realpath("/tmp"), "matrix-pin-"));
const servers: Server[] = [];
let peerFrames = 0;
async function listener(path: string, owner: string) {
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    let frame = ""; socket.setEncoding("utf8"); socket.on("data", (chunk) => { frame += chunk; });
    socket.once("end", () => { assert.equal(frame, "owner-only-frame"); if (owner === "peer") peerFrames++; socket.end(owner); });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  servers.push(server);
}
async function exchange(path: string) {
  return new Promise<string>((resolve, reject) => {
    const socket = createConnection({ path }); let result = ""; socket.setEncoding("utf8");
    socket.setTimeout(3000, () => socket.destroy(new Error("Pinned exchange timed out")));
    socket.once("error", reject); socket.on("data", (chunk) => { result += chunk; });
    socket.once("end", () => { socket.destroy(); resolve(result); }); socket.once("connect", () => socket.end("owner-only-frame"));
  });
}
const modes = ["symlink", "replacement", "parent"] as const;
try {
  for (const mode of modes) {
    const directory = join(root, mode); await mkdir(directory);
    const path = join(directory, "worker.sock"), peer = join(root, `${mode}-peer.sock`);
    await listener(path, "owner"); await listener(peer, "peer");
    const original = await lstat(path);
    const pin = await pinScopeRuntimeCommandSocket(path);
    assert.match(pin.path, /^\/proc\/self\/fd\/[0-9]+$/);
    assert.equal((await stat(pin.path)).ino, original.ino);
    // Controlled scheduling point: original inode was validated, but connect has not happened.
    if (mode === "parent") {
      await rename(directory, `${directory}-original`); await mkdir(directory); await symlink(peer, path);
    } else {
      await unlink(path);
      if (mode === "symlink") await symlink(peer, path);
      else await listener(path, "peer");
    }
    try { assert.equal(await exchange(pin.path), "owner"); assert.equal(peerFrames, 0); }
    finally { await pin.close(); await pin.close(); }
    await assert.rejects(stat(pin.path), { code: "ENOENT" });
  }
  const safe = join(root, "safe"); await mkdir(safe);
  const path = join(safe, "worker.sock"); await listener(path, "owner");
  const baseline = (await readdir("/proc/self/fd")).length;
  await symlink(path, join(safe, "symlink.sock"));
  await assert.rejects(pinScopeRuntimeCommandSocket(join(safe, "symlink.sock")));
  await link(path, join(safe, "hardlink.sock"));
  await assert.rejects(pinScopeRuntimeCommandSocket(path));
  await unlink(join(safe, "hardlink.sock"));
  await writeFile(join(safe, "regular"), "not a socket");
  await assert.rejects(pinScopeRuntimeCommandSocket(join(safe, "regular")));
  await symlink(safe, join(root, "foreign-directory"));
  await assert.rejects(pinScopeRuntimeCommandSocket(join(root, "foreign-directory", "worker.sock")));
  await assert.rejects(pinScopeRuntimeCommandSocket(join(safe, "absent.sock")));
  assert.equal((await readdir("/proc/self/fd")).length, baseline, "Rejected pins must close all opened descriptors");
  console.log(JSON.stringify({ node: process.version, platform: process.platform, architecture: process.arch,
    modes, ownerResponses: modes.length, peerFrames, rejectedSymlinkHardlinkRegularParentMissing: true,
    failureDescriptorsClosed: true, successfulDescriptorsClosed: true }));
} finally {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await rm(root, { recursive: true, force: true });
}
