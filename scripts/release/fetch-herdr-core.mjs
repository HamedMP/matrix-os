#!/usr/bin/env node
// Fetches the pinned herdr-core binary that backs local terminals in the
// Electron Desktop Terminal window (specs/651-desktop-terminal-window) and
// places it where electron-builder packs it: desktop/build/herdr/.
//
// The version, URLs and archive checksums are pinned in
// desktop/herdr-core.json. Nothing is downloaded from an unpinned location,
// and an archive whose SHA-256 differs is never unpacked.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const RELEASE_ORIGIN = "https://releases.herdr.dev";
// What is taken from the archive, and the name it ships under.
const PACKED_FILES = [["herdr-core", "hc"], ["LICENSE", "LICENSE"], ["THIRD-PARTY-NOTICES", "THIRD-PARTY-NOTICES"]];

export async function readHerdrCoreManifest(path = join(ROOT, "desktop/herdr-core.json")) {
  const manifest = JSON.parse(await readFile(path, "utf8"));
  if (typeof manifest.version !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(manifest.version)) {
    throw new Error("herdr-core.json: version must be an exact x.y.z");
  }
  for (const [target, entry] of Object.entries(manifest.targets ?? {})) {
    const url = new URL(entry.url);
    if (url.origin !== RELEASE_ORIGIN || !url.pathname.startsWith(`/core/${manifest.version}/`) || url.search || url.hash) {
      throw new Error(`herdr-core.json: ${target} must download version ${manifest.version} from ${RELEASE_ORIGIN}`);
    }
    if (!/^[0-9a-f]{64}$/.test(entry.sha256)) throw new Error(`herdr-core.json: ${target} needs a SHA-256`);
  }
  return manifest;
}

export function herdrCoreTarget(manifest, platform, arch) {
  const entry = manifest.targets[`${platform}-${arch}`];
  if (!entry) throw new Error(`no pinned herdr-core build for ${platform}-${arch}`);
  return entry;
}

async function download(url, fetchImpl) {
  // A fixed origin, no redirects, bounded time and size.
  const response = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`herdr-core download failed with status ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_ARCHIVE_BYTES) throw new Error("herdr-core archive has an unexpected size");
  return bytes;
}

/**
 * Downloads, verifies and unpacks one target into `outDir`. Returns the path
 * of the binary. `fetchImpl` is injectable for tests.
 */
export async function fetchHerdrCore({ platform, arch, outDir, manifest, fetchImpl = fetch }) {
  const pinned = manifest ?? await readHerdrCoreManifest();
  const target = herdrCoreTarget(pinned, platform, arch);
  const archive = await download(target.url, fetchImpl);
  const found = createHash("sha256").update(archive).digest("hex");
  if (found !== target.sha256) {
    throw new Error(`herdr-core ${platform}-${arch} checksum mismatch: expected ${target.sha256}, got ${found}`);
  }
  const work = await mkdtemp(join(tmpdir(), "herdr-core-"));
  try {
    const archivePath = join(work, "herdr-core.tar.gz");
    const unpacked = join(work, "unpacked");
    await writeFile(archivePath, archive, { flag: "wx" });
    await mkdir(unpacked);
    // Only the named members are extracted; anything else in the archive is ignored.
    await run("tar", ["-xzf", archivePath, "-C", unpacked, ...PACKED_FILES.map(([name]) => name)], { timeout: 30_000 });
    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });
    for (const [name, packedAs] of PACKED_FILES) {
      const source = join(unpacked, name);
      if (!(await lstat(source)).isFile()) throw new Error(`herdr-core archive member ${name} is not a regular file`);
      await copyFile(source, join(outDir, packedAs));
    }
    await chmod(join(outDir, "hc"), 0o755);
    await writeFile(join(outDir, "VERSION"), `${pinned.version}\n`);
    return join(outDir, "hc");
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const platform = option("platform", process.platform);
  const arch = option("arch", process.arch);
  const outDir = resolve(option("out", join(ROOT, "desktop/build/herdr")));
  try {
    const binary = await fetchHerdrCore({ platform, arch, outDir });
    console.log(`herdr-core for ${platform}-${arch} is ready at ${binary}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "herdr-core fetch failed");
    process.exit(1);
  }
}
