import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { assert, hash, noSymlinkAncestors } from "./control.mjs";
import { archiveMembers, verifyInstalledMembers } from "./archive.mjs";
const SDK = "@anthropic-ai/claude-agent-sdk", NATIVE = "@anthropic-ai/claude-agent-sdk-linux-x64";
export function frozenPackages(text) {
  assert(Buffer.byteLength(text) <= 8 * 1024 * 1024, "lockfile_capacity"); const lock = parse(text);
  const versions = new Set();
  for (const importer of Object.values(lock.importers ?? {})) for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const value = importer?.[section]?.[SDK]?.version; if (typeof value === "string") versions.add(value.split("(")[0]);
  }
  assert(versions.size === 1, "frozen_sdk_version_ambiguous"); const sdkVersion = [...versions][0];
  assert(/^0\.[0-9]+\.[0-9]+$/.test(sdkVersion), "frozen_sdk_version_invalid");
  const nativeVersions = new Set();
  for (const [key, value] of Object.entries(lock.snapshots ?? {})) if (key === `${SDK}@${sdkVersion}` || key.startsWith(`${SDK}@${sdkVersion}(`)) {
    if (typeof value.optionalDependencies?.[NATIVE] === "string") nativeVersions.add(value.optionalDependencies[NATIVE]);
  }
  assert(nativeVersions.size === 1, "frozen_native_version_ambiguous"); const nativeVersion = [...nativeVersions][0];
  assert(nativeVersion === sdkVersion, "frozen_native_version_mismatch");
  return [SDK, NATIVE].map(name => {
    const version = name === SDK ? sdkVersion : nativeVersion; const sri = lock.packages?.[`${name}@${version}`]?.resolution?.integrity;
    assert(typeof sri === "string" && /^sha512-[A-Za-z0-9+/]{86}==$/.test(sri), "frozen_integrity_missing");
    return { name, version, sri, archiveName: `${name.split("/")[1]}-${version}.tgz` };
  });
}
export async function verifyDependencies(config, marker) {
  const storage = `${config.appRoot}/node_modules/.pnpm/`; const roots = [];
  for (const name of [SDK, NATIVE]) {
    const root = await realpath(join(config.appRoot, "node_modules", name));
    assert(root.startsWith(storage), "dependency_outside_owned_storage"); roots.push(root);
  }
  const lockfile = join(config.appRoot, "pnpm-lock.yaml");
  await noSymlinkAncestors(lockfile, true); assert(await hash(lockfile) === marker.lockfileSha256, "dependency_lockfile_changed");
  const packages = frozenPackages(await readFile(lockfile, "utf8")); const verified = [];
  for (let index = 0; index < packages.length; index++) {
    const expected = packages[index], root = roots[index]; await noSymlinkAncestors(root, true);
    const manifestPath = join(root, "package.json");
    await noSymlinkAncestors(manifestPath, true); assert((await lstat(manifestPath)).size <= 65536, "manifest_capacity");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert(manifest.name === expected.name && manifest.version === expected.version, "frozen_manifest_mismatch");
    const archivePath = join(dirname(config.appRoot), "native-packages", expected.archiveName);
    await noSymlinkAncestors(archivePath, true); const metadata = await lstat(archivePath);
    assert(metadata.isFile() && metadata.nlink === 1, "package_archive_invalid");
    const archive = await archiveMembers(archivePath, expected.sri);
    const installed = await verifyInstalledMembers(root, archive.members);
    assert(Object.hasOwn(installed.members, "package.json"), "verified_manifest_missing");
    verified.push({ ...expected, root, archivePath, archiveSha256: await hash(archivePath), compressedBytes: archive.compressedBytes,
      installed, ...(index === 0 ? { claudeCodeVersion: manifest.claudeCodeVersion } : {}) });
  }
  assert(Object.hasOwn(verified[0].installed.members, "sdk.mjs") && Object.hasOwn(verified[1].installed.members, "claude"), "verified_runtime_entry_missing");
  assert(/^[0-9]+\.[0-9]+\.[0-9]+$/.test(verified[0].claudeCodeVersion), "frozen_native_cli_version_invalid");
  return { sdk: verified[0], native: verified[1], lockfileSha256: marker.lockfileSha256 };
}
