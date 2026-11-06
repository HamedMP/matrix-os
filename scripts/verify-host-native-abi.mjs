import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CUSTOMER_GLIBC = [2, 39]; // Ubuntu 24.04 customer VPS image.

export function requiredGlibcVersions(versionInfo) {
  return [...versionInfo.matchAll(/\bGLIBC_(\d+)\.(\d+)\b/g)]
    .map((match) => [Number(match[1]), Number(match[2])]);
}

export function exceedsCustomerGlibc(versionInfo) {
  return requiredGlibcVersions(versionInfo).some(([major, minor]) =>
    major > CUSTOMER_GLIBC[0] || (major === CUSTOMER_GLIBC[0] && minor > CUSTOMER_GLIBC[1]));
}

function* nativeModules(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* nativeModules(path);
    else if (entry.isFile() && entry.name.endsWith('.node')) yield path;
  }
}

function isLinuxX64Elf(path) {
  const header = Buffer.alloc(20);
  const fd = openSync(path, 'r');
  try {
    if (readSync(fd, header, 0, header.length, 0) < header.length) return false;
  } finally {
    closeSync(fd);
  }
  return header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    && header[4] === 2 && header[5] === 1 && header.readUInt16LE(18) === 62;
}

export function verifyHostNativeAbi(appDir, nodeBinary) {
  const requiredModules = [
    join(appDir, 'node_modules/node-pty/build/Release/pty.node'),
    join(appDir, 'packages/gateway/dist/collaboration/filesystem-identity.node'),
  ];
  for (const modulePath of requiredModules) {
    if (!existsSync(modulePath)) throw new Error(`Required host native module is missing: ${modulePath}`);
  }
  for (const modulePath of nativeModules(appDir)) {
    if (!isLinuxX64Elf(modulePath)) continue;
    const versionInfo = execFileSync('readelf', ['--version-info', modulePath], {
      encoding: 'utf8', timeout: 10_000, maxBuffer: 2 * 1024 * 1024,
    });
    if (exceedsCustomerGlibc(versionInfo)) {
      throw new Error(`Native module requires glibc newer than 2.39: ${modulePath}`);
    }
  }
  const loaded = spawnSync(nodeBinary, ['-e', 'require("node-pty")'], {
    cwd: appDir, encoding: 'utf8', timeout: 10_000,
  });
  if (loaded.error || loaded.status !== 0) {
    throw new Error(`Staged node-pty cannot load with bundled Node: ${loaded.stderr || loaded.error?.message || loaded.status}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [appDir, nodeBinary] = process.argv.slice(2);
  if (!appDir || !nodeBinary) {
    console.error('Usage: verify-host-native-abi.mjs <staged-app> <bundled-node>');
    process.exitCode = 2;
  } else {
    try {
      verifyHostNativeAbi(resolve(appDir), resolve(nodeBinary));
      console.log('Staged native modules are compatible with Ubuntu 24.04');
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
