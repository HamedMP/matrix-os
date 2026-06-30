// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createShellSnapshotScope,
  loadShellSnapshot,
  saveShellSnapshot,
  SHELL_SNAPSHOT_STORAGE_PREFIX,
} from "../../shell/src/lib/shell-snapshot-cache";

const freshSnapshot = {
  theme: {
    name: "cached",
    mode: "dark",
    colors: { background: "#101010", foreground: "#f5f5f5" },
    fonts: { sans: "Inter, sans-serif", mono: "JetBrains Mono, monospace" },
    radius: "12px",
  },
  desktopConfig: {
    background: { type: "wallpaper", name: "cached-wallpaper.jpg" },
    dock: { position: "bottom", size: 64, iconSize: 44, autoHide: false },
    pinnedApps: ["apps/notes/index.html"],
  },
  bootstrap: {
    layout: { windows: [{ id: "w1", path: "__terminal__", title: "Terminal" }] },
    apps: [{ name: "Notes", path: "/files/apps/notes/index.html", icon: "notes", slug: "notes" }],
    modules: [],
    icons: {
      notes: { url: "/icons/notes.png", etag: "\"abc\"", versionedUrl: "/icons/notes.png?v=abc" },
    },
  },
};

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

describe("shell snapshot cache", () => {
  let storage: Storage;

  beforeEach(() => {
    storage = createMemoryStorage();
    vi.restoreAllMocks();
  });

  it("keys snapshots by Clerk user id and runtime path scope", () => {
    const primary = createShellSnapshotScope({ userId: "user_123", pathname: "/" });
    const vm = createShellSnapshotScope({ userId: "user_123", pathname: "/vm/staging" });
    const otherUser = createShellSnapshotScope({ userId: "user_456", pathname: "/" });

    expect(primary?.storageKey).toContain(SHELL_SNAPSHOT_STORAGE_PREFIX);
    expect(primary?.storageKey).not.toBe(vm?.storageKey);
    expect(primary?.storageKey).not.toBe(otherUser?.storageKey);
  });

  it("does not create a readable cache scope without a loaded user id", () => {
    expect(createShellSnapshotScope({ userId: null, pathname: "/" })).toBeNull();
    expect(createShellSnapshotScope({ userId: undefined, pathname: "/" })).toBeNull();
  });

  it("round-trips a sanitized snapshot", () => {
    const scope = createShellSnapshotScope({ userId: "user_123", pathname: "/" });
    expect(scope).not.toBeNull();

    saveShellSnapshot(scope, freshSnapshot, storage);

    expect(loadShellSnapshot(scope, storage)).toEqual(expect.objectContaining({
      theme: expect.objectContaining({ name: "cached" }),
      desktopConfig: expect.objectContaining({ background: { type: "wallpaper", name: "cached-wallpaper.jpg" } }),
      bootstrap: expect.objectContaining({ apps: freshSnapshot.bootstrap.apps }),
    }));
  });

  it("ignores corrupt, stale, and oversized entries", () => {
    const scope = createShellSnapshotScope({ userId: "user_123", pathname: "/" });
    expect(scope).not.toBeNull();

    storage.setItem(scope!.storageKey, "{not json");
    expect(loadShellSnapshot(scope, storage)).toBeNull();

    storage.setItem(scope!.storageKey, JSON.stringify({
      version: 1,
      updatedAt: Date.now() - 15 * 24 * 60 * 60 * 1000,
      data: freshSnapshot,
    }));
    expect(loadShellSnapshot(scope, storage)).toBeNull();

    storage.setItem(scope!.storageKey, "x".repeat(180_000));
    expect(loadShellSnapshot(scope, storage)).toBeNull();
  });

  it("drops unknown or unsafe bootstrap and desktop fields instead of trusting raw localStorage", () => {
    const scope = createShellSnapshotScope({ userId: "user_123", pathname: "/" });
    expect(scope).not.toBeNull();

    saveShellSnapshot(scope, {
      desktopConfig: {
        background: { type: "image", url: "javascript:alert(1)" },
        dock: { position: "sideways", size: 10000, iconSize: -1, autoHide: true },
        pinnedApps: ["apps/safe/index.html", "../escape"],
      },
      bootstrap: {
        layout: { windows: "bad" },
        apps: [{ name: "Safe", path: "/files/apps/safe/index.html", icon: "../bad", slug: "safe" }],
        modules: "bad",
        icons: { "../bad": { url: "javascript:alert(1)", etag: null, versionedUrl: "javascript:alert(1)" } },
      },
    }, storage);

    const loaded = loadShellSnapshot(scope, storage);

    expect(loaded?.desktopConfig?.background).toEqual({ type: "wallpaper", name: "moraine-lake.jpg" });
    expect(loaded?.desktopConfig?.dock).toEqual({ position: "left", size: 56, iconSize: 40, autoHide: false });
    expect(loaded?.desktopConfig?.pinnedApps).toEqual(["apps/safe/index.html"]);
    expect(loaded?.bootstrap?.layout).toEqual({});
    expect(loaded?.bootstrap?.modules).toEqual([]);
    expect(loaded?.bootstrap?.apps).toEqual([{ name: "Safe", path: "/files/apps/safe/index.html", icon: undefined, slug: "safe" }]);
    expect(loaded?.bootstrap?.icons).toEqual({});
  });
});
