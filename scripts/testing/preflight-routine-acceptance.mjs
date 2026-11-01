/** Offline only: reads source/artifacts/manifests; never starts a service or sends a request. */
import { readFile, realpath, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { parse } from "yaml";
const hash = value => createHash("sha256").update(value).digest("hex");
const json = async path => JSON.parse(await readFile(path,"utf8"));
export async function verifyRoutineArtifact(root, directory, expectedHead) {
  root = await realpath(root);
  const manifest = await json(join(directory,"build.json")), failures = [];
  if (manifest.head !== expectedHead) failures.push("build_head_mismatch");
  if (manifest.root !== root) failures.push("build_root_mismatch");
  if (hash(await readFile(join(root,"pnpm-lock.yaml"))) !== manifest.lockSha256) failures.push("lock_mismatch");
  if (!Array.isArray(manifest.artifacts) || !manifest.artifacts.length) failures.push("empty_artifacts");
  for (const required of ["bot-worker.mjs","routine-process.mjs"]) {
    if (manifest.artifacts?.filter(artifact => artifact.file === required).length !== 1) failures.push(`required_artifact_missing_or_duplicate:${required}`);
  }
  let inputCount = 0;
  for (const artifact of manifest.artifacts ?? []) {
    if (!/^[a-z0-9-]+\.mjs$/.test(artifact.file)) { failures.push("invalid_artifact_path"); continue; }
    try { if (hash(await readFile(join(directory,artifact.file))) !== artifact.sha256) failures.push(`artifact_mismatch:${artifact.file}`); }
    catch (error) { if (error.code !== "ENOENT") throw error; failures.push(`artifact_missing:${artifact.file}`); }
    if (!Array.isArray(artifact.sources) || !artifact.sources.length) failures.push("empty_sources");
    for (const source of artifact.sources ?? []) {
      inputCount++;
      const path = resolve(root,source.path);
      try {
        if (await realpath(path) !== source.realPath || hash(await readFile(path)) !== source.sha256) failures.push(`source_mismatch:${source.path}`);
      } catch (error) { if (error.code !== "ENOENT") throw error; failures.push(`source_missing:${source.path}`); }
    }
  }
  return { ok: !failures.length, buildHead: manifest.head, inputCount, failures, liveQualified: false };
}
export async function inventoryRoutineDependencies(root) {
  const lock = parse(await readFile(join(root,"pnpm-lock.yaml"),"utf8"));
  const directories = ["shell","desktop"];
  for (const parent of ["packages","apps"]) {
    for (const entry of await readdir(join(root,parent),{withFileTypes:true})) if (entry.isDirectory()) directories.push(`${parent}/${entry.name}`);
  }
  if (directories.length > 128) throw new Error("workspace_inventory_capacity_exceeded");
  const manifests = new Map(); // bounded by checkout workspace directories; lifetime is one CLI run.
  for (const directory of directories) {
    try { const pkg = await json(join(root,directory,"package.json")); manifests.set(pkg.name,{directory,pkg}); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const pending = ["@matrix-os/gateway","@matrix-os/bot-runtime","@matrix-os/scope-runtime"], visited = new Set(), checks = [];
  // Workspace closure of the deployed gateway + formal Bot/scope worker; client builds are separately gated.
  while (pending.length) {
    const name = pending.shift(); if (visited.has(name)) continue; visited.add(name);
    const entry = manifests.get(name); if (!entry) { checks.push({name,ok:false,reason:"workspace_missing"}); continue; }
    for (const [dependency,specifier] of Object.entries(entry.pkg.dependencies ?? {})) {
      const recorded = lock.importers?.[entry.directory]?.dependencies?.[dependency];
      const row = { workspace: entry.directory, name: dependency, specifier, locked: recorded?.version, ok:false };
      try {
        if (specifier.startsWith("workspace:")) pending.push(dependency);
        let location = join(root,entry.directory,"node_modules",dependency), actual;
        try { actual = await json(join(location,"package.json")); }
        catch (error) { if (error.code !== "ENOENT") throw error; location = join(root,"node_modules",dependency); actual = await json(join(location,"package.json")); }
        row.actual = actual.version; row.realPath = await realpath(location);
        if (specifier.startsWith("workspace:")) {
          const target = manifests.get(dependency);
          row.ok = Boolean(target && row.realPath === await realpath(join(root,target.directory)) && recorded?.specifier === specifier);
        } else row.ok = recorded?.specifier === specifier && String(recorded?.version).split("(")[0] === actual.version;
        if (!row.ok) row.reason = "lock_or_workspace_mismatch";
      } catch (error) { if (error.code !== "ENOENT") throw error; row.reason = "installed_dependency_missing"; }
      checks.push(row);
    }
  }
  return { ok:checks.every(row=>row.ok), workspaces:[...visited], directDependencyEdges:checks.length, checks,
    scope:"runtime workspace closure/direct dependencies, not transitive native ABI, release loader or client build qualification" };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [directory,expectedHead] = process.argv.slice(2);
  if (!directory || !/^[a-f0-9]{40}$/.test(expectedHead ?? "")) throw new Error("Usage: preflight-routine-acceptance.mjs <artifact-directory> <exact-build-head>");
  const artifact = await verifyRoutineArtifact(process.cwd(),resolve(directory),expectedHead);
  const dependencies = await inventoryRoutineDependencies(process.cwd());
  console.log(JSON.stringify({ checkedAt:new Date().toISOString(), platform:process.platform, arch:process.arch, node:process.version,
    artifact,dependencies,liveQualified:false,unverified:["full host/gateway release loader","Linux systemd/DynamicUser scope launch",
      "existing account background consent and real inference","client build parity and surface evidence"] },null,2));
  if (!artifact.ok || !dependencies.ok) process.exitCode=1;
}
