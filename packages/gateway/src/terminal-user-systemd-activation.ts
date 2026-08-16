import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";

export const TERMINAL_USER_SYSTEMD_ACTIVATION_MARKER = "TERMINAL_USER_SYSTEMD_ENABLED";

function hasCode(err: unknown, code: string): boolean {
  return err instanceof Error && "code" in err && err.code === code;
}

export async function resolveUserSystemdTerminalActivation(options: {
  appDir: string;
  envValue?: string;
}): Promise<boolean> {
  if (options.envValue !== undefined) {
    return options.envValue === "1";
  }

  const markerPath = join(options.appDir, TERMINAL_USER_SYSTEMD_ACTIVATION_MARKER);
  let marker: Awaited<ReturnType<typeof open>> | undefined;
  try {
    marker = await open(markerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await marker.stat();
    if (!stat.isFile() || stat.size !== 2) return false;
    return (await marker.readFile("utf8")) === "1\n";
  } catch (err: unknown) {
    if (hasCode(err, "ENOENT") || hasCode(err, "ENOTDIR") || hasCode(err, "ELOOP")) {
      return false;
    }
    console.warn(
      "[terminal-runtime] Activation marker check failed closed:",
      err instanceof Error ? err.name : typeof err,
    );
    return false;
  } finally {
    if (marker) {
      await marker.close().catch((err: unknown) => {
        console.warn(
          "[terminal-runtime] Activation marker close failed:",
          err instanceof Error ? err.name : typeof err,
        );
      });
    }
  }
}
