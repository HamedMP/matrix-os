import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { getSystemInfo } from "../../packages/gateway/src/system-info";
import { evaluateDesktopReleaseState } from "../../packages/contracts/src/release-alignment";
import hostInfo from "../fixtures/host-release-system-info.json";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it("compares the real host system-info producer without container build variables", () => {
  const home = mkdtempSync(join(tmpdir(), "host-alignment-"));
  try {
    mkdirSync(join(home, "system"));
    const releasePath = join(home, "release.json");
    vi.stubEnv("MATRIX_RELEASE_FILE", releasePath);
    vi.stubEnv("MATRIX_BUILD_SHA", undefined);
    vi.stubEnv("MATRIX_VERSION", undefined);
    const writeRelease = (version: string, gitCommit: string) => writeFileSync(releasePath,
      JSON.stringify({ ...hostInfo.release, version, gitCommit, gitRef: "main",
        buildTime: "2026-09-10T00:00:00.000Z" }));
    const desktop = { commit: "b".repeat(40), ancestors: [hostInfo.release.gitCommit] };
    writeRelease(hostInfo.version, hostInfo.release.gitCommit);
    const running = { runningVersion: hostInfo.runningVersion };
    const before = getSystemInfo(home, running);
    expect(before.build.sha).toBe("unknown");
    expect(evaluateDesktopReleaseState(before, desktop).status).toBe("runtime-update-required");

    // The installer can replace release.json while the old process still runs.
    writeRelease("v2026.09.10-1209", desktop.commit);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 60_000);
    expect(evaluateDesktopReleaseState(getSystemInfo(home, running), desktop).status).toBe("unavailable");
    expect(evaluateDesktopReleaseState(getSystemInfo(home, {
      runningVersion: "v2026.09.10-1209",
    }), desktop).status).toBe("aligned");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
