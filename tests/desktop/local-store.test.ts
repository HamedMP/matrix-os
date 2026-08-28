import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLocalStore, PANEL_LAYOUT_MAX_AGE_MS } from "@desktop/main/persistence/local-store";

async function makeDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "operator-store-"));
}

describe("local store", () => {
  it("round-trips typed keys", async () => {
    const dir = await makeDir();
    const store = createLocalStore({ dir });
    await store.set("appearance", { theme: "dark" });
    await store.set("lastProjectSlug", "matrix-os");
    expect(await store.get("appearance")).toEqual({ theme: "dark" });
    expect(await store.get("lastProjectSlug")).toBe("matrix-os");
  });

  it("persists only bounded canonical composer preferences", async () => {
    const store = createLocalStore({ dir: await makeDir() });
    const preferences = {
      defaultProviderId: "codex",
      composerSelections: {
        codex_default: {
          options: [{ id: "effort", value: "high" }],
          permissionMode: "full_access",
        },
      },
    };

    await store.set("providerPreferences", preferences);

    expect(await store.get("providerPreferences")).toEqual(preferences);
    await expect(store.setUnknown("providerPreferences", {
      ...preferences,
      composerSelections: {
        "../escape": {
          options: [{ id: "effort", value: "high" }],
          permissionMode: "full_access",
        },
      },
    })).rejects.toThrow();
  });

  it("persists bounded desktop release notes for the post-update What's New dialog", async () => {
    const store = createLocalStore({ dir: await makeDir() });
    const release = {
      version: "1.2.3",
      releaseDate: "2026-08-11T09:00:00.000Z",
      notes: "## Improved\n\n- Faster project loading",
      shown: false,
    };

    await store.set("desktopUpdateRelease", release);

    expect(await store.get("desktopUpdateRelease")).toEqual(release);
    await expect(store.setUnknown("desktopUpdateRelease", {
      ...release,
      notes: "x".repeat(40_000),
    })).rejects.toThrow();
  });

  it("acknowledges only the matching release inside the serialized mutation", async () => {
    const store = createLocalStore({ dir: await makeDir() });
    const currentRelease = {
      version: "1.2.3",
      notes: "## Fixed\n\n- Current release",
      shown: false,
    };
    const newerRelease = {
      version: "1.2.4",
      notes: "## New\n\n- Newer downloaded release",
      shown: false,
    };
    await store.set("desktopUpdateRelease", currentRelease);

    const replaceWithNewer = store.set("desktopUpdateRelease", newerRelease);
    const staleAcknowledgement = store.acknowledgeDesktopUpdateRelease("1.2.3");

    await expect(staleAcknowledgement).resolves.toBe(false);
    await replaceWithNewer;
    expect(await store.get("desktopUpdateRelease")).toEqual(newerRelease);
    await expect(store.acknowledgeDesktopUpdateRelease("1.2.4")).resolves.toBe(true);
    expect(await store.get("desktopUpdateRelease")).toEqual({
      ...newerRelease,
      shown: true,
    });
  });

  it("returns null for unset keys", async () => {
    const store = createLocalStore({ dir: await makeDir() });
    expect(await store.get("lastProjectSlug")).toBeNull();
  });

  it("writes atomically (no partial files left behind)", async () => {
    const dir = await makeDir();
    const store = createLocalStore({ dir });
    await store.set("windowBounds", { x: 1, y: 2, width: 800, height: 600 });
    const files = await readdir(dir);
    expect(files.some((f) => f.includes(".tmp"))).toBe(false);
    const raw = JSON.parse(await readFile(join(dir, "state.json"), "utf8"));
    expect(raw.windowBounds.width).toBe(800);
  });

  it("recovers from a corrupt state file", async () => {
    const dir = await makeDir();
    await writeFile(join(dir, "state.json"), "{not json", "utf8");
    const store = createLocalStore({ dir });
    expect(await store.get("appearance")).toBeNull();
    await store.set("appearance", { theme: "light" });
    expect(await store.get("appearance")).toEqual({ theme: "light" });
  });

  it("rejects invalid values for known keys", async () => {
    const store = createLocalStore({ dir: await makeDir() });
    await expect(store.set("appearance", { theme: "neon" } as never)).rejects.toThrow();
    await expect(store.set("windowBounds", { x: "a" } as never)).rejects.toThrow();
  });

  it("round-trips appearance themeId and zoom while bounding the factor", async () => {
    const store = createLocalStore({ dir: await makeDir() });
    await store.set("appearance", { theme: "dark", themeId: "nord", zoom: 1.3 });
    expect(await store.get("appearance")).toEqual({ theme: "dark", themeId: "nord", zoom: 1.3 });
    await expect(store.setUnknown("appearance", { theme: "dark", zoom: 2.5 })).rejects.toThrow();
    await expect(store.setUnknown("appearance", { theme: "dark", zoom: 0.1 })).rejects.toThrow();
  });

  it("persists only supported native desktop modes", async () => {
    const store = createLocalStore({ dir: await makeDir() });

    await store.set("desktopShell", { mode: "canvas" });

    expect(await store.get("desktopShell")).toEqual({ mode: "canvas" });
    await expect(store.setUnknown("desktopShell", { mode: "ambient" })).rejects.toThrow();
    await expect(store.setUnknown("desktopShell", { mode: "canvas", privateState: true })).rejects.toThrow();
  });

  it("persists only a bounded Terminal-local light or dark preference", async () => {
    const store = createLocalStore({ dir: await makeDir() });

    await store.set("terminalAppearance", { appThemeId: "light" });

    expect(await store.get("terminalAppearance")).toEqual({ appThemeId: "light" });
    await expect(store.setUnknown("terminalAppearance", { mode: "system" })).rejects.toThrow();
    await expect(store.setUnknown("terminalAppearance", { mode: "dark", themeId: "dracula" })).rejects.toThrow();
  });

  it("validates unknown IPC state values before writing", async () => {
    const store = createLocalStore({ dir: await makeDir() });
    await store.setUnknown("appearance", { theme: "system" });
    await expect(store.setUnknown("appearance", { theme: "neon" })).rejects.toThrow();
    expect(await store.get("appearance")).toEqual({ theme: "system" });
  });

  it("persists only bounded per-project view references", async () => {
    const store = createLocalStore({ dir: await makeDir() });
    const viewsState = {
      runtimeScope: "operator|https://platform.test|primary",
      views: {
        "matrix-os": { view: "chats" as const, selectedThreadId: "thread_plan", touchedAt: 1_750_000_000_000 },
      },
    };

    await store.set("projectViews", viewsState);
    expect(await store.get("projectViews")).toEqual(viewsState);
    await expect(store.setUnknown("projectViews", {
      ...viewsState,
      views: { "matrix-os": { view: "chats", selectedThreadId: "thread_plan", touchedAt: 1, transcript: ["private"] } },
    })).rejects.toThrow();
    await expect(store.setUnknown("projectViews", {
      ...viewsState,
      views: { "matrix-os": { view: "kanban", selectedThreadId: null, touchedAt: 1 } },
    })).rejects.toThrow();
  });

  it("prunes panel layouts not touched within the max age", async () => {
    const dir = await makeDir();
    const now = 1_750_000_000_000;
    const store = createLocalStore({ dir, clock: () => now });
    await store.setPanelLayout("proj/task-fresh", {
      order: ["terminal"],
      visible: { terminal: true },
      sizes: { terminal: 100 },
      touchedAt: now - 1000,
    });
    await store.setPanelLayout("proj/task-stale", {
      order: ["terminal"],
      visible: { terminal: true },
      sizes: { terminal: 100 },
      touchedAt: now - PANEL_LAYOUT_MAX_AGE_MS - 1,
    });
    const layouts = await store.get("panelLayouts");
    expect(layouts).not.toBeNull();
    expect(Object.keys(layouts!)).toEqual(["proj/task-fresh"]);
  });
});
