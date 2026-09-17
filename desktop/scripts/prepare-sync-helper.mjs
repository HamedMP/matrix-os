#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { arch as hostArch, platform as hostPlatform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "..");
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SUPPORTED_PLATFORMS = new Set(["darwin", "linux"]);
const SUPPORTED_ARCHES = new Set(["x64", "arm64"]);

function assertTarget(platform, arch, cliVersion) {
  if (!SUPPORTED_PLATFORMS.has(platform)) throw new Error(`unsupported helper platform: ${platform}`);
  if (!SUPPORTED_ARCHES.has(arch)) throw new Error(`unsupported helper architecture: ${arch}`);
  if (!VERSION_PATTERN.test(cliVersion)) throw new Error("invalid helper version");
}

async function replaceDirectoryAtomically(stagingDir, outputDir) {
  const backupDir = `${outputDir}.previous-${randomUUID()}`;
  let movedExisting = false;
  try {
    try {
      await rename(outputDir, backupDir);
      movedExisting = true;
    } catch (err) {
      if (!(err instanceof Error) || !("code" in err) || err.code !== "ENOENT") throw err;
    }
    await rename(stagingDir, outputDir);
    if (movedExisting) await rm(backupDir, { recursive: true, force: true });
  } catch (err) {
    if (movedExisting) {
      await rename(backupDir, outputDir).catch(() => undefined);
    }
    throw err;
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function prepareSyncHelper(options) {
  const { sourceDir, outputDir, cliVersion, platform, arch } = options;
  assertTarget(platform, arch, cliVersion);
  const name = `matrix-${cliVersion}-${platform}-${arch}`;
  const sourcePath = resolve(sourceDir, name);
  const checksumPath = resolve(sourceDir, `${name}.sha256`);
  const sourceInfo = await lstat(sourcePath);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
    throw new Error("helper source must be a regular file");
  }
  const checksum = (await readFile(checksumPath, "utf8")).trim();
  const expectedMatch = checksum.match(/^([a-f0-9]{64})  ([^/\\]+)$/);
  if (!expectedMatch || expectedMatch[2] !== name) throw new Error("invalid helper checksum file");
  const sourceBytes = await readFile(sourcePath);
  const sha256 = createHash("sha256").update(sourceBytes).digest("hex");
  if (sha256 !== expectedMatch[1]) throw new Error("helper digest mismatch");

  await mkdir(dirname(outputDir), { recursive: true });
  const stagingDir = await mkdtemp(join(dirname(outputDir), ".sync-helper-"));
  const executable = "matrix";
  await copyFile(sourcePath, join(stagingDir, executable));
  await chmod(join(stagingDir, executable), 0o755);
  await writeFile(join(stagingDir, "manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    available: true,
    protocolVersion: 1,
    cliVersion,
    platform,
    arch,
    executable,
    sha256,
  }, null, 2)}\n`, { mode: 0o644 });
  await replaceDirectoryAtomically(stagingDir, outputDir);
}

export async function prepareUnavailableSyncHelper(options) {
  const { outputDir, platform, arch } = options;
  await mkdir(dirname(outputDir), { recursive: true });
  const stagingDir = await mkdtemp(join(dirname(outputDir), ".sync-helper-"));
  await writeFile(join(stagingDir, "manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    available: false,
    protocolVersion: 1,
    platform,
    arch,
    reason: "platform_unsupported",
  }, null, 2)}\n`, { mode: 0o644 });
  await replaceDirectoryAtomically(stagingDir, outputDir);
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const platform = optionValue(args, "--platform") ?? hostPlatform();
  const arch = optionValue(args, "--arch") ?? hostArch();
  const outputDir = resolve(optionValue(args, "--output") ?? join(desktopRoot, "build", "sync-helper"));
  if (args.includes("--unsupported")) {
    await prepareUnavailableSyncHelper({ outputDir, platform, arch });
    return;
  }
  const pkg = JSON.parse(await readFile(join(repoRoot, "packages", "sync-client", "package.json"), "utf8"));
  const cliVersion = optionValue(args, "--version") ?? pkg.version;
  const sourceDir = resolve(optionValue(args, "--source") ?? join(repoRoot, "dist", "cli-binaries"));
  await prepareSyncHelper({ sourceDir, outputDir, cliVersion, platform, arch });
  process.stdout.write(`Prepared Matrix sync helper ${cliVersion} for ${platform}-${arch}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
