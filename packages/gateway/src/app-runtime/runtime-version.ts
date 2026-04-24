import { satisfies } from "semver";
import { ManifestError } from "./errors.js";

export const RUNTIME_VERSION = "1.0.0";

/**
 * Assert that the app manifest's runtimeVersion is compatible with the
 * current runtime. Called by install flow before the trust gate runs.
 *
 * Missing runtimeVersion is treated as pre-1.0 (^0.0.0) -- incompatible
 * with the 1.0.0+ runtime.
 */
export function assertRuntimeCompatible(manifest: {
  runtimeVersion: string | undefined;
}): void {
  const range = manifest.runtimeVersion;

  if (!range) {
    throw new ManifestError(
      "runtime_version_mismatch",
      `app has no runtimeVersion (treated as pre-1.0); runtime is ${RUNTIME_VERSION}`,
    );
  }

  if (!satisfies(RUNTIME_VERSION, range)) {
    throw new ManifestError(
      "runtime_version_mismatch",
      `app requires runtimeVersion ${range} but runtime is ${RUNTIME_VERSION}`,
    );
  }
}
