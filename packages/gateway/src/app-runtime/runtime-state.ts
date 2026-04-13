import { readBuildStamp } from "./build-cache.js";
import type { AppManifest } from "./manifest-schema.js";

export type RuntimeState =
  | { status: "ready" }
  | { status: "needs_build" }
  | { status: "build_failed"; stage: "install" | "build"; exitCode: number; stderrTail: string }
  | { status: "process_idle" }
  | { status: "process_failed"; lastError: { code: string; stderrTail: string }; restartCount: number };

const MAX_STDERR_TAIL = 2048;

function sanitizeStderrTail(tail: string): string {
  // Cap at 2KB and strip any bearer token substrings
  let sanitized = tail.slice(-MAX_STDERR_TAIL);
  sanitized = sanitized.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
  return sanitized;
}

export async function computeRuntimeState(
  manifest: AppManifest,
  appDir: string,
): Promise<RuntimeState> {
  if (manifest.runtime === "static") {
    return { status: "ready" };
  }

  if (manifest.runtime === "vite") {
    const stamp = await readBuildStamp(appDir);
    if (!stamp) {
      return { status: "needs_build" };
    }
    if (stamp.exitCode !== 0) {
      return {
        status: "build_failed",
        stage: "build",
        exitCode: stamp.exitCode,
        stderrTail: sanitizeStderrTail(""),
      };
    }
    return { status: "ready" };
  }

  // node runtime: check build stamp first, then process manager state
  if (manifest.runtime === "node") {
    const stamp = await readBuildStamp(appDir);
    if (!stamp) {
      return { status: "needs_build" };
    }
    if (stamp.exitCode !== 0) {
      return {
        status: "build_failed",
        stage: "build",
        exitCode: stamp.exitCode,
        stderrTail: sanitizeStderrTail(""),
      };
    }
    // Process manager state would be checked here in Phase 2
    return { status: "process_idle" };
  }

  return { status: "needs_build" };
}
