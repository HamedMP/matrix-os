import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { createHash, createHmac } from "node:crypto";
import { join, relative } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Must mirror SAFE_SLUG in packages/gateway/src/app-runtime/paths.ts so the
// publisher can never produce a slug the gateway will later refuse.
const SAFE_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
// SemVer 2.0.0 without the `v` prefix. Keeps the segment that gets joined into
// `storeDir/{slug}/{version}` free of `.` traversal and shell metacharacters.
const SEMVER_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export interface PublishOptions {
  appDir: string;
  storeDir: string;
}

export interface PublishArtifacts {
  sourceTar: string;
  distTar?: string;
  distHash?: string;
  signature: string;
  manifestPath: string;
}

export type PublishResult =
  | { ok: true; artifacts: PublishArtifacts }
  | { ok: false; error: Error };

interface Manifest {
  name: string;
  slug: string;
  version: string;
  runtime: string;
  runtimeVersion: string;
  build?: {
    output: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

async function hashDirectory(dirPath: string): Promise<string> {
  const hash = createHash("sha256");
  const files: string[] = [];

  async function collectFiles(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await collectFiles(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }

  await collectFiles(dirPath);
  files.sort((a, b) => relative(dirPath, a).localeCompare(relative(dirPath, b)));

  for (const file of files) {
    const relPath = relative(dirPath, file);
    hash.update(relPath);
    const content = await readFile(file);
    hash.update(content);
  }

  return hash.digest("hex");
}

function signBundle(manifestJson: string): string {
  // Publishers must supply MATRIX_PUBLISH_KEY. Shipping a hardcoded fallback
  // would mean anyone who reads this repo can forge signatures accepted by
  // installVerifiedApp's trusted path.
  const key = process.env.MATRIX_PUBLISH_KEY;
  if (!key || key.length < 32) {
    throw new Error(
      "MATRIX_PUBLISH_KEY environment variable is required (min 32 chars) to sign a bundle",
    );
  }
  const hmac = createHmac("sha256", key);
  hmac.update(manifestJson);
  return hmac.digest("hex");
}

async function createTarball(sourceDir: string, outputPath: string, excludes: string[] = []): Promise<void> {
  const args = ["czf", outputPath, "-C", sourceDir];
  for (const exclude of excludes) {
    args.push("--exclude", exclude);
  }
  args.push(".");
  await execFileAsync("tar", args, { timeout: 30_000 });
}

export async function publishApp(opts: PublishOptions): Promise<PublishResult> {
  const { appDir, storeDir } = opts;

  // Read and validate manifest
  let rawJson: string;
  try {
    rawJson = await readFile(join(appDir, "matrix.json"), "utf8");
  } catch (err: unknown) {
    return {
      ok: false,
      error: new Error(
        `matrix.json not found: ${err instanceof Error ? err.message : String(err)}`,
      ),
    };
  }

  let manifest: Manifest;
  try {
    manifest = JSON.parse(rawJson) as Manifest;
  } catch {
    return { ok: false, error: new Error("invalid JSON in matrix.json") };
  }

  // Basic validation
  if (!manifest.name || !manifest.slug || !manifest.version || !manifest.runtime || !manifest.runtimeVersion) {
    return { ok: false, error: new Error("manifest missing required fields (name, slug, version, runtime, runtimeVersion)") };
  }
  // slug and version are joined into a filesystem path below; a malicious or
  // typoed manifest.json with `"../"` segments would escape storeDir and
  // clobber arbitrary files on the publisher's machine.
  if (!SAFE_SLUG.test(manifest.slug)) {
    return { ok: false, error: new Error(`invalid manifest.slug: must match ${SAFE_SLUG}`) };
  }
  if (!SEMVER_RE.test(manifest.version)) {
    return { ok: false, error: new Error(`invalid manifest.version: must be semver (e.g. 1.2.3)`) };
  }

  const bundleDir = join(storeDir, manifest.slug, manifest.version);
  await mkdir(bundleDir, { recursive: true });

  try {
    // Create source tarball
    const sourceTar = join(bundleDir, "source.tar.gz");
    await createTarball(appDir, sourceTar, ["node_modules", "dist"]);

    // Create dist tarball if the app has a build output
    let distTar: string | undefined;
    let distHash: string | undefined;
    if (manifest.build?.output) {
      const distDir = join(appDir, manifest.build.output);
      try {
        const distStats = await stat(distDir);
        if (distStats.isDirectory()) {
          distTar = join(bundleDir, "dist.tar.gz");
          await createTarball(distDir, distTar);

          // Hash the dist directory
          distHash = await hashDirectory(distDir);
        }
      } catch {
        // No dist directory -- that's okay for some apps
      }
    }

    // Sign the bundle
    const signature = signBundle(rawJson);

    // Write manifest to store
    const manifestPath = join(bundleDir, "matrix.json");
    await writeFile(manifestPath, rawJson);

    // Write signature
    await writeFile(join(bundleDir, "signature"), signature);

    // Write dist hash if available
    if (distHash) {
      await writeFile(join(bundleDir, "dist-hash"), distHash);
    }

    return {
      ok: true,
      artifacts: {
        sourceTar,
        distTar,
        distHash,
        signature,
        manifestPath,
      },
    };
  } catch (err: unknown) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}
