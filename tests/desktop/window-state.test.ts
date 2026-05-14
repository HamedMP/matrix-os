import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_DESKTOP_WINDOW_STATE,
  loadDesktopWindowState,
  saveDesktopWindowState,
} from "../../apps/desktop/src/main/config.js";

describe("desktop window state", () => {
  it("returns stable defaults when no state file exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "matrix-desktop-state-"));
    try {
      await expect(loadDesktopWindowState(join(dir, "window-state.json"))).resolves.toEqual(
        DEFAULT_DESKTOP_WINDOW_STATE,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("persists bounded window state and ignores unsafe dimensions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "matrix-desktop-state-"));
    const path = join(dir, "window-state.json");
    try {
      await saveDesktopWindowState(path, {
        width: 1800,
        height: 1100,
        x: 24,
        y: 36,
        maximized: true,
        lastLoadedUrl: "https://matrix.example.com/shell",
      });

      await expect(loadDesktopWindowState(path)).resolves.toEqual({
        width: 1800,
        height: 1100,
        x: 24,
        y: 36,
        maximized: true,
        lastLoadedUrl: "https://matrix.example.com/shell",
      });

      await saveDesktopWindowState(path, {
        width: 10,
        height: 1,
        maximized: false,
      });

      await expect(loadDesktopWindowState(path)).resolves.toMatchObject({
        width: DEFAULT_DESKTOP_WINDOW_STATE.width,
        height: DEFAULT_DESKTOP_WINDOW_STATE.height,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
