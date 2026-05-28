import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { loadTuiPreferences, saveTuiPreferences } from "../../src/cli/tui/preferences.js";

describe("TUI preferences", () => {
  it("loads defaults when no preference file exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "matrix-tui-prefs-"));

    await expect(loadTuiPreferences({ configDir: dir })).resolves.toMatchObject({
      preferences: { theme: "system", defaultView: "home" },
      recovered: false,
    });
  });

  it("writes owner-readable non-secret preferences", async () => {
    const dir = await mkdtemp(join(tmpdir(), "matrix-tui-prefs-"));

    await saveTuiPreferences({ theme: "dark", mascotVisible: false }, { configDir: dir });

    await expect(readFile(join(dir, "tui.json"), "utf8")).resolves.toContain('"theme": "dark"');
  });

  it("recovers safely from malformed preference files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "matrix-tui-prefs-"));
    await import("node:fs/promises").then(({ mkdir, writeFile }) =>
      mkdir(dir, { recursive: true }).then(() => writeFile(join(dir, "tui.json"), "{")),
    );

    await expect(loadTuiPreferences({ configDir: dir })).resolves.toMatchObject({
      preferences: { theme: "system", defaultView: "home" },
      recovered: true,
    });
  });
});
