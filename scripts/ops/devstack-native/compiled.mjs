import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
import { assert, hash } from "./control.mjs";
import { inspectPlacement } from "./placement.mjs";
const REQUIRED = ["main.js", "worker.js", "host-config.js", "protocol.js", "systemd-unit-identity.js", "profile.js", "server.js", "supervisor.js", "systemd-launcher.js"];
export async function compiledRuntimeInventory(appRoot) {
  const root = join(appRoot, "packages/scope-runtime/dist");
  assert((await inspectPlacement(root)).length === 0, "compiled_root_missing");
  const files = {}; let entries = 0, bytes = 0;
  const walk = async (directory, prefix = "", depth = 0) => {
    assert(depth <= 4, "compiled_depth_capacity"); const iterator = await opendir(directory);
    for await (const item of iterator) {
      assert(++entries <= 512 && !item.isSymbolicLink(), "compiled_link_or_capacity");
      const path = join(directory, item.name), relative = prefix ? `${prefix}/${item.name}` : item.name, metadata = await lstat(path);
      assert(!metadata.isSymbolicLink() && (metadata.uid === 0 || metadata.uid === process.getuid()) && (metadata.mode & 0o022) === 0, "compiled_target_unprotected");
      if (metadata.isDirectory()) { await walk(path, relative, depth + 1); continue; }
      assert(metadata.isFile(), "compiled_entry_invalid");
      if (!/\.(?:js|mjs|cjs)$/.test(item.name)) continue;
      assert(Object.keys(files).length < 128 && metadata.size <= 64 * 1024 * 1024, "compiled_file_capacity");
      bytes += metadata.size; assert(bytes <= 128 * 1024 * 1024, "compiled_bytes_capacity");
      files[relative] = { sha256: await hash(path), size: metadata.size, inode: metadata.ino, device: metadata.dev };
    }
  };
  await walk(root); assert(REQUIRED.every(name => Object.hasOwn(files, name)), "compiled_required_import_missing");
  return { root, bytes, files: Object.fromEntries(Object.entries(files).sort()) };
}
export async function verifyCompiledRuntime(appRoot, expected) {
  const observed = await compiledRuntimeInventory(appRoot);
  assert(JSON.stringify(observed) === JSON.stringify(expected), "compiled_inventory_changed"); return observed;
}
