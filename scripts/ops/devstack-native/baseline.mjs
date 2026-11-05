import { lstat, opendir, readFile, readdir, realpath } from "node:fs/promises";
import { assert, hash, must, stat } from "./control.mjs";
export async function show(unit, keys) {
  const text = await must("/usr/bin/systemctl", ["show", unit, ...keys.map(key => `--property=${key}`)], "unit_evidence_unavailable"); const values = {};
  for (const line of text.split("\n")) { const i = line.indexOf("="); const key = line.slice(0, i);
    assert(keys.includes(key) && line.length <= 16384, "unit_evidence_invalid"); values[key] = line.slice(i + 1); }
  assert(keys.every(key => Object.hasOwn(values, key)), "unit_evidence_missing"); return values;
}
export async function definitionEvidence(info, budget = { files: 0, bytes: 0 }) {
  assert(typeof info.FragmentPath === "string" && info.FragmentPath.startsWith("/"), "unit_definition_missing");
  const paths = [info.FragmentPath, ...(info.DropInPaths || "").split(/\s+/).filter(Boolean)].sort(); assert(paths.length <= 32, "unit_definition_capacity");
  const evidence = {};
  for (const path of paths) {
    assert(!/[\n\r\0]/.test(path), "unit_definition_path_invalid"); const resolved = await realpath(path), entry = await lstat(resolved);
    assert(entry.isFile() && entry.size <= 1024 * 1024 && (entry.uid === 0 || entry.uid === process.getuid()) && (entry.mode & 0o022) === 0, "unit_definition_unprotected");
    budget.files++; budget.bytes += entry.size; assert(budget.files <= 512 && budget.bytes <= 8 * 1024 * 1024, "unit_definition_total_capacity");
    evidence[path] = { resolved, sha256: await hash(resolved), inode: entry.ino, device: entry.dev, size: entry.size };
  }
  return evidence;
}
export async function socketInventory(roots) {
  const sockets = {}, absent = []; let count = 0;
  const walk = async (path, depth, role) => {
    const metadata = await stat(path); if (!metadata) { absent.push({ path, role }); return; }
    assert(metadata.isDirectory() && !metadata.isSymbolicLink(), "socket_inventory_directory_invalid");
    const directory = await opendir(path);
    for await (const item of directory) {
      assert(++count <= 2048 && /^[A-Za-z0-9_.@-]{1,128}$/.test(item.name) && !item.isSymbolicLink(), "socket_inventory_capacity_or_link");
      const child = `${path}/${item.name}`, entry = await lstat(child);
      if (entry.isSocket()) sockets[child] = { role, inode: entry.ino, device: entry.dev, mode: entry.mode, uid: entry.uid, gid: entry.gid, links: entry.nlink, ctimeMs: entry.ctimeMs };
      else if (entry.isDirectory() && depth > 0) await walk(child, depth - 1, role);
    }
  };
  for (const root of roots) await walk(root.path, root.depth, root.role);
  return { sockets: Object.fromEntries(Object.entries(sockets).sort()), absent: absent.sort((a, b) => a.path.localeCompare(b.path)) };
}
export async function installedArtifactEvidence(entries) {
  assert(entries.length <= 32, "installed_artifact_capacity"); const artifacts = {};
  for (const { path, required } of entries) {
    const entry = await stat(path);
    if (!entry) { assert(!required, "required_artifact_baseline_missing"); artifacts[path] = { classification: "optional_absent" }; continue; }
    assert(entry.isFile() && !entry.isSymbolicLink(), "installed_artifact_invalid");
    artifacts[path] = { sha256: await hash(path), inode: entry.ino, device: entry.dev, size: entry.size };
  }
  return artifacts;
}
export async function hostSnapshot(config) {
  const listing = await must("/usr/bin/systemctl", ["list-units", "--all", "--plain", "--no-legend", "matrix*.service"], "peer_inventory_unavailable");
  const names = listing.split("\n").map(line => line.trim().split(/\s+/)[0]).filter(Boolean);
  const required = ["matrix-gateway.service", "matrix-shell.service", "matrix-sync-agent.service"];
  const units = [...new Set([...names, ...required, "matrix-scope-runtime.service"])].sort();
  assert(units.length <= 128 && units.every(name => /^matrix[A-Za-z0-9_.@-]*\.service$/.test(name)), "peer_inventory_capacity");
  const services = {}, definitionBudget = { files: 0, bytes: 0 };
  for (const unit of units) {
    if (unit === config.supervisorUnit || unit.startsWith(config.workerUnitPrefix)) continue;
    const info = await show(unit, ["LoadState", "ActiveState", "SubState", "InvocationID", "MainPID", "NRestarts", "FragmentPath", "DropInPaths", "UnitFileState"]);
    if (info.LoadState === "not-found") { assert(!required.includes(unit), "required_service_baseline_missing"); services[unit] = { classification: "absent" }; continue; }
    assert(info.LoadState === "loaded", "service_baseline_unknown");
    if (required.includes(unit)) assert(info.ActiveState === "active" && /^[a-f0-9]{32}$/.test(info.InvocationID) && Number(info.MainPID) > 1, "required_service_incarnation_missing");
    services[unit] = { ...info, definitions: await definitionEvidence(info, definitionBudget) };
  }
  const artifacts = await installedArtifactEvidence([
    ...["/opt/matrix/release.json", "/opt/matrix/app/BUNDLE_VERSION", "/opt/matrix/bin/matrix-gateway", "/opt/matrix/bin/matrix-shell", "/opt/matrix/bin/matrix-sync-agent", "/opt/matrix/app/packages/gateway/dist/main.js"].map(path => ({ path, required: true })),
    ...["/opt/matrix/bin/matrix-scope-runtime", "/opt/matrix/app/packages/scope-runtime/dist/main.js"].map(path => ({ path, required: services["matrix-scope-runtime.service"]?.classification !== "absent" })),
  ]);
  const roots = [{ path: "/run/matrix-scope-runtime", depth: 0, role: "legacy_ipc" }, { path: "/run/matrix-scope", depth: 0, role: "legacy_ipc" }];
  if (await stat("/run/matrix-devstack")) {
    const entries = await readdir("/run/matrix-devstack", { withFileTypes: true }); assert(entries.length <= 64, "peer_namespace_capacity");
    for (const entry of entries) if (entry.isDirectory() && entry.name !== config.namespace) {
      roots.push({ path: `/run/matrix-devstack/${entry.name}/scope-runtime`, depth: 0, role: "peer_ipc" }, { path: `/run/matrix-devstack/${entry.name}/c`, depth: 1, role: "peer_command" });
    }
  }
  const legacy = "/var/lib/matrix-scope-runtime/runtimes";
  if (await stat(legacy)) { const entries = await readdir(legacy, { withFileTypes: true }); assert(entries.length <= 128, "legacy_runtime_capacity");
    for (const entry of entries) if (entry.isDirectory() && /^[a-f0-9]{32}$/.test(entry.name)) roots.push({ path: `${legacy}/${entry.name}/command`, depth: 0, role: "legacy_command" }); }
  const inventory = await socketInventory(roots);
  assert(Object.values(inventory.sockets).some(value => value.role === "legacy_ipc"), "required_legacy_socket_baseline_missing");
  return { services, artifacts, ...inventory };
}
