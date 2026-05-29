import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { loadTuiPreferences } from "../../src/cli/tui/preferences.js";
import { aggregateTuiStatusSnapshot } from "../../src/cli/tui/status.js";

describe("TUI resilience", () => {
  it("recovers defaults from malformed preferences", async () => {
    const dir = await mkdtemp(join(tmpdir(), "matrix-tui-resilience-"));
    try {
      await writeFile(join(dir, "tui.json"), "not json");

      await expect(loadTuiPreferences({ configDir: dir })).resolves.toMatchObject({
        recovered: true,
        preferences: { theme: "system" },
      });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("turns partial status failures into safe degraded state", async () => {
    const snapshot = await aggregateTuiStatusSnapshot({
      resolveProfile: async () => ({ name: "cloud", gatewayUrl: "https://app.matrix-os.com", platformUrl: "https://app.matrix-os.com" }),
      loadAuth: async () => ({ authenticated: true, expired: false, handle: "nim" }),
      checkGateway: async () => { throw new Error("/Users/private/postgres://secret"); },
      checkDaemon: async () => ({ state: "healthy", label: "running" }),
      listShellSessions: async () => [],
    });

    expect(snapshot.overall).toBe("degraded");
    expect(snapshot.safeError?.message).toBe("Request failed");
  });
});
