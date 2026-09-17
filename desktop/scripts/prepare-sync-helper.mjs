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
const LINUX_ELF_TARGETS = {
  x64: { machine: 62, interpreter: "/lib64/ld-linux-x86-64.so.2" },
  arm64: { machine: 183, interpreter: "/lib/ld-linux-aarch64.so.1" },
};

function assertTarget(platform, arch, cliVersion) {
  if (!SUPPORTED_PLATFORMS.has(platform)) throw new Error(`unsupported helper platform: ${platform}`);
  if (!SUPPORTED_ARCHES.has(arch)) throw new Error(`unsupported helper architecture: ${arch}`);
  if (!VERSION_PATTERN.test(cliVersion)) throw new Error("invalid helper version");
}

function readElfUint64(bytes, offset) {
  const value = bytes.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("invalid Linux helper ELF metadata");
  return Number(value);
}

function readLinuxElfInterpreter(bytes, expectedMachine) {
  if (
    bytes.byteLength < 64
    || bytes[0] !== 0x7f
    || bytes[1] !== 0x45
    || bytes[2] !== 0x4c
    || bytes[3] !== 0x46
    || bytes[4] !== 2
    || bytes[5] !== 1
    || bytes.readUInt16LE(18) !== expectedMachine
  ) {
    throw new Error("invalid Linux helper ELF target");
  }
  const programHeaderOffset = readElfUint64(bytes, 32);
  const programHeaderSize = bytes.readUInt16LE(54);
  const programHeaderCount = bytes.readUInt16LE(56);
  if (programHeaderSize < 56 || programHeaderCount < 1 || programHeaderCount > 1_024) {
    throw new Error("invalid Linux helper ELF metadata");
  }
  for (let index = 0; index < programHeaderCount; index += 1) {
    const headerOffset = programHeaderOffset + index * programHeaderSize;
    if (headerOffset < 0 || headerOffset + 56 > bytes.byteLength) {
      throw new Error("invalid Linux helper ELF metadata");
    }
    if (bytes.readUInt32LE(headerOffset) !== 3) continue;
    const interpreterOffset = readElfUint64(bytes, headerOffset + 8);
    const interpreterSize = readElfUint64(bytes, headerOffset + 32);
    if (
      interpreterSize < 2
      || interpreterSize > 4_096
      || interpreterOffset < 0
      || interpreterOffset + interpreterSize > bytes.byteLength
    ) {
      throw new Error("invalid Linux helper ELF interpreter");
    }
    const encoded = bytes.subarray(interpreterOffset, interpreterOffset + interpreterSize);
    if (encoded.at(-1) !== 0) throw new Error("invalid Linux helper ELF interpreter");
    return encoded.subarray(0, -1).toString("utf8");
  }
  throw new Error("missing Linux helper ELF interpreter");
}

function assertPortableExecutable(sourceBytes, platform, arch) {
  if (platform !== "linux") return;
  const target = LINUX_ELF_TARGETS[arch];
  const interpreter = readLinuxElfInterpreter(sourceBytes, target.machine);
  if (interpreter !== target.interpreter) {
    throw new Error("non-portable Linux helper interpreter");
  }
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
      try {
        await rename(backupDir, outputDir);
      } catch (rollbackErr) {
        console.warn("[sync-helper] Failed to restore the previous packaged helper", {
          errorType: rollbackErr instanceof Error ? rollbackErr.name : "NonErrorThrown",
        });
      }
    }
    throw err;
  } finally {
    try {
      await rm(stagingDir, { recursive: true, force: true });
    } catch (cleanupErr) {
      console.warn("[sync-helper] Failed to remove a helper staging directory", {
        errorType: cleanupErr instanceof Error ? cleanupErr.name : "NonErrorThrown",
      });
    }
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
  assertPortableExecutable(sourceBytes, platform, arch);

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
