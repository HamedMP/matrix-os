import { readFile, mkdir, cp, rm } from "node:fs/promises";
import { join, basename } from "node:path";
import { existsSync } from "node:fs";
import { satisfies } from "semver";
import { resolveWithinHome } from "../path-security.js";
import { ManifestError, BuildError } from "./errors.js";
import { parseManifest, type AppManifest } from "./manifest-schema.js";
import { BuildOrchestrator } from "./build-orchestrator.js";

export const RUNTIME_VERSION = "1.0.0";

export type InstallResult =
  | { ok: true; manifest: AppManifest }
  | { ok: false; error: ManifestError | BuildError };

export interface InstallOptions {
  sourceDir: string;
  homeDir: string;
  storeDir?: string;
}

export async function installApp(opts: InstallOptions): Promise<InstallResult> {
  const { sourceDir, homeDir, storeDir } = opts;

  // Read and validate manifest from source
  let rawJson: string;
  try {
    rawJson = await readFile(join(sourceDir, "matrix.json"), "utf8");
  } catch (err: unknown) {
    return {
      ok: false,
      error: new ManifestError(
        "not_found",
        `matrix.json not found in source: ${err instanceof Error ? err.message : String(err)}`,
      ),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return {
      ok: false,
      error: new ManifestError("invalid_manifest", "invalid JSON in source matrix.json"),
    };
  }

  const result = await parseManifest(parsed);
  if (!result.ok) {
    return result;
  }
  const manifest = result.manifest;

  // Verify slug matches directory name
  const dirName = basename(sourceDir);
  if (manifest.slug !== dirName) {
    return {
      ok: false,
      error: new ManifestError(
        "slug_mismatch",
        `manifest slug "${manifest.slug}" does not match directory name "${dirName}"`,
      ),
    };
  }

  // Check runtime version compatibility
  if (!satisfies(RUNTIME_VERSION, manifest.runtimeVersion)) {
    return {
      ok: false,
      error: new ManifestError(
        "runtime_version_mismatch",
        `app requires runtimeVersion ${manifest.runtimeVersion} but runtime is ${RUNTIME_VERSION}`,
      ),
    };
  }

  // Resolve target directory
  const appsDir = join(homeDir, "apps");
  const targetDir = resolveWithinHome(appsDir, manifest.slug);
  if (targetDir === null) {
    return {
      ok: false,
      error: new ManifestError("not_found", `slug "${manifest.slug}" escapes apps directory`),
    };
  }

  // For idempotent reinstall, remove existing directory
  const freshInstall = !existsSync(targetDir);
  if (!freshInstall) {
    await rm(targetDir, { recursive: true, force: true });
  }

  try {
    // Copy source to target
    await mkdir(targetDir, { recursive: true });
    await cp(sourceDir, targetDir, { recursive: true });

    // Build if needed
    if (manifest.runtime !== "static" && manifest.build) {
      const orchestrator = new BuildOrchestrator({
        concurrency: 2,
        storeDir,
      });

      const buildResult = await orchestrator.build(manifest.slug, targetDir);
      if (!buildResult.ok) {
        // Rollback on build failure
        await rm(targetDir, { recursive: true, force: true });
        return buildResult;
      }
    }

    return { ok: true, manifest };
  } catch (err: unknown) {
    // Rollback on any error
    if (freshInstall) {
      await rm(targetDir, { recursive: true, force: true });
    }
    return {
      ok: false,
      error: new ManifestError(
        "invalid_manifest",
        `install failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
    };
  }
}
