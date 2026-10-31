// No package imports: persistent runtime validation must never resolve mutable app code.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
const MAX_FILES = 512, MAX_BYTES = 512 * 1024 * 1024, MAX_FILE_BYTES = 256 * 1024 * 1024;
const required = ["node", "zellij", "matrix-terminal-user-keeper.mjs", "matrix-terminal-attach.mjs", "terminal-host.mjs", "terminal-service.mjs", "terminal-io-attach.mjs", "terminal-protocol.mjs", "generation-closure.mjs", "terminal-writer.node", "node_modules/node-pty/package.json", "node_modules/node-pty/lib/index.js", "node_modules/node-pty/lib/unixTerminal.js", "node_modules/node-pty/build/Release/pty.node", "node_modules/node-addon-api/package.json"];
const fail = () => { throw new Error("Terminal runtime closure unavailable"); };
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const safePath = value => typeof value === "string" && value.length <= 240 && value.split("/").every(part => /^[A-Za-z0-9_.-]+$/.test(part) && part !== "." && part !== "..");
function runtimeMetadata(value) {
  if (!exact(value, ["version", "modules", "napi", "platform", "arch", "libc", "nodePty", "nodeAddonApi", "writerNapi", "protocol"])
    || !/^24\.[0-9]+\.[0-9]+$/.test(value.version) || !/^[1-9][0-9]{0,3}$/.test(value.modules) || !/^[1-9][0-9]{0,2}$/.test(value.napi)
    || value.platform !== "linux" || !["x64", "arm64"].includes(value.arch) || !/^(glibc:[0-9]+\.[0-9]+|musl)$/.test(value.libc)
    || value.nodePty !== "1.1.0" || !/^7\.1\.[0-9]+$/.test(value.nodeAddonApi) || value.writerNapi !== 8 || value.protocol !== 1) fail();
  return value;
}
function manifestValue(value) {
  if (!exact(value, ["version", "runtime", "assets"]) || value.version !== 2 || !Array.isArray(value.assets) || value.assets.length > MAX_FILES) fail();
  runtimeMetadata(value.runtime);
  let previous = "", bytes = 0;
  for (const asset of value.assets) {
    if (!exact(asset, ["path", "sha256", "size", "mode"]) || !safePath(asset.path) || asset.path <= previous || ["GENERATION", "closure.json"].includes(asset.path)
      || !/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.size) || asset.size < 0 || asset.size > MAX_FILE_BYTES
      || ![0o644, 0o755].includes(asset.mode)) fail();
    previous = asset.path; bytes += asset.size;
  }
  if (bytes > MAX_BYTES || required.some(name => !value.assets.some(asset => asset.path === name))) fail();
  if (value.assets.find(asset => asset.path === "node").mode !== 0o755 || value.assets.find(asset => asset.path === "zellij").mode !== 0o755) fail();
  return value;
}
async function regular(path, max = MAX_FILE_BYTES) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > max || info.mode & 0o7022 || ![0, process.getuid?.()].includes(info.uid)) fail();
    return { handle, info };
  } catch (error) { await handle.close(); throw error; }
}
async function hashFile(path) {
  const { handle, info } = await regular(path);
  try {
    const hash = createHash("sha256"); let size = 0;
    for await (const bytes of handle.createReadStream({ autoClose: false })) { size += bytes.length; if (size > MAX_FILE_BYTES) fail(); hash.update(bytes); }
    const after = await handle.stat();
    if (size !== info.size || info.size !== after.size || info.mtimeMs !== after.mtimeMs || info.ctimeMs !== after.ctimeMs) fail();
    return { sha256: hash.digest("hex"), size, mode: info.mode & 0o777 };
  } finally { await handle.close(); }
}
async function readBounded(path, max) {
  const { handle } = await regular(path, max);
  try { const bytes = Buffer.alloc(max + 1), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0); if (bytesRead > max) fail(); return bytes.subarray(0, bytesRead).toString("utf8"); }
  finally { await handle.close(); }
}
async function inventory(directory) {
  const files = []; let visited = 0;
  async function walk(relative) {
    if (++visited > MAX_FILES * 2) fail();
    const path = join(directory, relative), info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o7022 || ![0, process.getuid?.()].includes(info.uid)) fail();
    const entries = await readdir(path, { withFileTypes: true });
    if (entries.length > MAX_FILES) fail();
    for (const entry of entries) {
      const name = relative ? relative + "/" + entry.name : entry.name;
      if (!safePath(name) || entry.isSymbolicLink()) fail();
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) {
        if (!["GENERATION", "closure.json"].includes(name)) files.push(name);
        if (files.length > MAX_FILES) fail();
      } else fail();
    }
  }
  await walk(""); return files.sort();
}
export function terminalClosureGeneration(manifest) {
  return "gen_" + createHash("sha256").update("matrix-terminal-generation-v2\n").update(JSON.stringify(manifestValue(manifest)) + "\n").digest("hex");
}
export async function createTerminalClosureManifest(directory, runtime) {
  runtimeMetadata(runtime);
  const names = await inventory(directory), assets = [];
  for (const path of names) assets.push({ path, ...await hashFile(join(directory, path)) });
  return manifestValue({ version: 2, runtime, assets });
}
export async function validateTerminalClosure(directory, generation, expectedRuntime) {
  if (!/^gen_[a-f0-9]{64}$/.test(generation)) fail();
  const bytes = await readBounded(join(directory, "closure.json"), 262144), manifest = manifestValue(JSON.parse(bytes));
  if (bytes !== JSON.stringify(manifest) + "\n" || terminalClosureGeneration(manifest) !== generation
    || (await readBounded(join(directory, "GENERATION"), 256)).trim() !== generation) fail();
  if (expectedRuntime && Object.entries(runtimeMetadata(expectedRuntime)).some(([key, value]) => manifest.runtime[key] !== value)) fail();
  const names = await inventory(directory);
  if (names.join("\n") !== manifest.assets.map(asset => asset.path).join("\n")) fail();
  for (const asset of manifest.assets) {
    const actual = await hashFile(join(directory, asset.path));
    if (actual.sha256 !== asset.sha256 || actual.size !== asset.size || actual.mode !== asset.mode) fail();
  }
  return manifest;
}
export async function legacyTerminalGeneration(directory) {
  const hashes = [];
  for (const name of required.slice(1, 4)) hashes.push((await hashFile(join(directory, name))).sha256);
  return "gen_" + createHash("sha256").update(hashes.join("\n") + "\n").digest("hex");
}
/** Optional upgrade preserves legacy live descriptors. A present broken closure is never legacy. */
export async function validateTerminalClosureIfPresent(directory, generation) {
  try { await lstat(join(directory, "closure.json")); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    for (const name of ["node", "terminal-host.mjs", "terminal-writer.node"]) {
      try { await lstat(join(directory, name)); }
      catch (missing) { if (missing instanceof Error && "code" in missing && missing.code === "ENOENT") continue; throw missing; }
      fail(); // A damaged v2 package cannot silently downgrade to the legacy readiness contract.
    }
    return undefined;
  }
  return validateTerminalClosure(directory, generation);
}
export async function assertPinnedTerminalRuntime(directory, generation) {
  const manifest = await validateTerminalClosure(directory, generation), runtime = manifest.runtime;
  const libc = process.report.getReport().header.glibcVersionRuntime;
  if (await realpath(process.execPath) !== await realpath(join(resolve(directory), "node")) || process.versions.node !== runtime.version
    || process.versions.modules !== runtime.modules || process.versions.napi !== runtime.napi || process.platform !== runtime.platform || process.arch !== runtime.arch
    || (libc ? `glibc:${libc}` : "musl") !== runtime.libc) fail();
  return manifest;
}
