/**
 * App install flow with verified path and trust gate.
 *
 * ack-store contract (shared between session and install endpoints):
 * - Session endpoint uses peekAck (non-consuming) to validate the ack
 *   token before issuing a signed cookie.
 * - Install endpoint uses consumeAck (terminal) to validate and consume
 *   the ack token, ensuring one-time use.
 * - The same ack token covers both endpoints in one user flow.
 *   The session endpoint peeks first, then the install endpoint consumes.
 *   If the install endpoint is called second, it consumes the token.
 *   Contributors: do NOT accidentally double-consume.
 */

import { readFile, mkdir, cp, rm } from "node:fs/promises";
import { join, basename } from "node:path";
import { existsSync } from "node:fs";
import { satisfies } from "semver";
import { resolveWithinHome } from "../path-security.js";
import { ManifestError, BuildError } from "./errors.js";
import { parseManifest, type AppManifest } from "./manifest-schema.js";
import { BuildOrchestrator } from "./build-orchestrator.js";
import { hashSources } from "./build-cache.js";
import {
  computeDistributionStatus,
  sandboxCapabilities,
} from "./distribution-policy.js";
import type { AckStore } from "./ack-store.js";

export const RUNTIME_VERSION = "1.0.0";

export type InstallResult =
  | { ok: true; manifest: AppManifest }
  | { ok: false; error: ManifestError | BuildError };

export interface InstallOptions {
  sourceDir: string;
  homeDir: string;
  storeDir?: string;
}

export interface VerifiedInstallOptions extends InstallOptions {
  listingTrust: string;
  declaredDistHash?: string;
}

export interface TrustGateInput {
  listingTrust: string;
  slug: string;
  principal: string;
  ack: string | undefined;
  ackStore: AckStore;
}

const TRUSTED_TIERS = new Set(["first_party", "verified_partner"]);

/**
 * Install-time trust gate (spec Install Flow step 6).
 *
 * Calls computeDistributionStatus as the single source of truth for
 * the install/gated/blocked decision. Consumes the ack token via
 * consumeAck (terminal) -- the same token may have been peeked by
 * the session endpoint earlier in the user flow.
 *
 * @throws ManifestError with code "install_blocked_by_policy" if blocked
 * @throws ManifestError with code "install_gated" if gated without valid ack
 */
export function assertInstallAllowed(input: TrustGateInput): void {
  const { listingTrust, slug, principal, ack, ackStore } = input;
  const caps = sandboxCapabilities();
  const status = computeDistributionStatus(listingTrust, caps);

  if (status === "installable") {
    return;
  }

  if (status === "blocked") {
    throw new ManifestError(
      "install_blocked_by_policy",
      `app install blocked by policy for listingTrust "${listingTrust}"`,
    );
  }

  // status === "gated": require a valid ack token
  if (!ack) {
    throw new ManifestError(
      "install_gated",
      `app install requires acknowledgment for listingTrust "${listingTrust}"`,
    );
  }

  // consumeAck is terminal -- this is the single consumer
  const record = ackStore.consumeAck(slug, principal, ack);
  if (!record) {
    throw new ManifestError(
      "install_gated",
      `invalid or expired ack token for "${slug}"`,
    );
  }
}

/**
 * Trusted install path: installs an app from a source directory.
 * Used for first_party and verified_partner apps where the pre-built
 * dist is trusted.
 */
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

/**
 * Verified install path for gallery-delivered apps.
 *
 * For first_party/verified_partner: trusts the pre-built dist and
 * uses the standard install path.
 *
 * For community: discards any shipped dist/, rebuilds from source via
 * BuildOrchestrator, hashes the output, and compares to the publisher's
 * declared hash. Fails with BuildError.code = "hash_mismatch" on divergence.
 */
export async function installVerifiedApp(
  opts: VerifiedInstallOptions,
): Promise<InstallResult> {
  const { sourceDir, homeDir, storeDir, listingTrust, declaredDistHash } = opts;

  // For trusted tiers, use the standard install path
  if (TRUSTED_TIERS.has(listingTrust)) {
    return installApp({ sourceDir, homeDir, storeDir });
  }

  // Community tier: rebuild from source and verify hash
  // First, read and validate the manifest
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

  const parseResult = await parseManifest(parsed);
  if (!parseResult.ok) {
    return parseResult;
  }
  const manifest = parseResult.manifest;

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

    // Discard any shipped dist/ -- we rebuild from source for community tier
    const distDir = join(targetDir, manifest.build?.output ?? "dist");
    if (existsSync(distDir)) {
      await rm(distDir, { recursive: true, force: true });
    }

    // Rebuild from source
    if (manifest.build) {
      const orchestrator = new BuildOrchestrator({
        concurrency: 2,
        storeDir,
      });

      const buildResult = await orchestrator.build(manifest.slug, targetDir);
      if (!buildResult.ok) {
        await rm(targetDir, { recursive: true, force: true });
        return buildResult;
      }

      // Hash the rebuilt output and compare to declared hash
      if (declaredDistHash) {
        const outputDir = join(targetDir, manifest.build.output);
        const sourceGlobs = ["**/*"];
        const rebuiltHash = await hashSources(outputDir, sourceGlobs);

        if (rebuiltHash !== declaredDistHash) {
          await rm(targetDir, { recursive: true, force: true });
          return {
            ok: false,
            error: new BuildError(
              "hash_mismatch",
              "build",
              0,
              `rebuilt dist hash ${rebuiltHash} does not match declared hash ${declaredDistHash}`,
            ),
          };
        }
      }
    }

    return { ok: true, manifest };
  } catch (err: unknown) {
    if (freshInstall) {
      await rm(targetDir, { recursive: true, force: true });
    }
    return {
      ok: false,
      error: new ManifestError(
        "invalid_manifest",
        `verified install failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
    };
  }
}
