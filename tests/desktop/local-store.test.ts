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
