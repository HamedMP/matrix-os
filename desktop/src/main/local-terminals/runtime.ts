// Where the herdr-core binary and its private directories live, and how the
// core is started. Kept apart from the host so the host stays unit-testable.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describeError } from "./describe-error";

export interface LocalTerminalRuntime {
  binaryPath: string | null;
  runtimeDir: string;
  dataDir: string;
}

/**
 * The bundled binary ships at `<resources>/herdr/hc`. The app never runs an
 * `hc` found on PATH. A development build may name one explicitly with
 * MATRIX_DESKTOP_HC_PATH; packaged builds ignore that variable.
 */
export function resolveLocalTerminalRuntime(input: {
  isPackaged: boolean; resourcesPath: string; userData: string; home: string; env: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
}): LocalTerminalRuntime {
  const exists = input.exists ?? existsSync;
  const bundled = join(input.resourcesPath, "herdr", "hc");
  const override = input.isPackaged ? undefined : input.env.MATRIX_DESKTOP_HC_PATH;
  const binaryPath = override && override.startsWith("/") ? override : exists(bundled) ? bundled : null;
  // Unix socket paths are short, so sockets live under the home directory in a
  // directory named for this profile; state and config stay in userData.
  const profile = createHash("sha256").update(input.userData).digest("hex").slice(0, 8);
  return {
    binaryPath,
    runtimeDir: join(input.home, ".matrixos", "dt", profile),
    dataDir: join(input.userData, "herdr"),
  };
}

/** Starts the detached core. It exits quickly; the core keeps running. */
export function startLocalTerminalCore(binaryPath: string, env: Record<string, string>, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(binaryPath, ["server", "start"], { env, timeout: timeoutMs, maxBuffer: 64 * 1024, windowsHide: true }, (error, _stdout, stderr) => {
      if (!error) { resolve(); return; }
      // The reason goes to the main-process log only.
      console.warn("[local-terminals] core start failed:", describeError(error), String(stderr).slice(0, 500));
      reject(new Error("local terminal runtime failed to start"));
    });
  });
}
