import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PANEL_KINDS,
  PANEL_MIN_PCT,
  WORKSPACE_LRU_CAP,
  defaultLayout,
  normalizeLayout,
  useWorkspace,
  type PanelKind,
  type PanelLayout,
} from "@desktop/renderer/src/stores/workspace";

function makePersistence(layouts: Record<string, PanelLayout> | null = null) {
  return {
    loadLayouts: vi.fn().mockResolvedValue(layouts),
    saveLayout: vi.fn().mockResolvedValue(undefined),
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  useWorkspace.setState({ entries: [], layouts: {}, hydrated: false });
  useWorkspace.getState().configure(makePersistence());
});

describe("defaultLayout", () => {
  it("orders all panel kinds with only the terminal visible at full width", () => {
    const layout = defaultLayout(1_000);
    expect(layout.order).toEqual([...PANEL_KINDS]);
    expect(layout.visible.terminal).toBe(true);
    for (const kind of PANEL_KINDS.filter((k) => k !== "terminal")) {
      expect(layout.visible[kind]).toBe(false);
      expect(layout.sizes[kind]).toBe(0);
    }
    expect(layout.sizes.terminal).toBe(100);
    expect(layout.touchedAt).toBe(1_000);
  });
});

describe("openTask / focusTask / closeTask", () => {
  it("adds opened tasks most-recently-focused first, deterministically on equal timestamps", () => {
    const store = useWorkspace.getState();
    store.openTask("task_a", 1_000);
    store.openTask("task_b", 1_000);
    expect(useWorkspace.getState().entries.map((e) => e.taskId)).toEqual(["task_b", "task_a"]);
    expect(useWorkspace.getState().entries.every((e) => e.live)).toBe(true);
  });

  it("re-opening an existing task bumps it to the front without duplicating", () => {
    const store = useWorkspace.getState();
    store.openTask("task_a", 1_000);
    store.openTask("task_b", 2_000);
    store.openTask("task_a", 3_000);
    const entries = useWorkspace.getState().entries;
    expect(entries.map((e) => e.taskId)).toEqual(["task_a", "task_b"]);
    expect(entries[0]!.lastFocusedAt).toBe(3_000);
  });

  it("evicts least-recently-focused entries beyond the LRU cap but keeps them restorable", () => {
    const store = useWorkspace.getState();
    for (let i = 0; i < WORKSPACE_LRU_CAP; i += 1) {
      expect(store.openTask(`task_${i}`, 1_000 + i).evicted).toEqual([]);
    }
    const overflow = store.openTask("task_extra", 9_000);
    expect(overflow.evicted).toEqual(["task_0"]);

    const entries = useWorkspace.getState().entries;
    expect(entries).toHaveLength(WORKSPACE_LRU_CAP + 1);
    const evictedEntry = entries.find((e) => e.taskId === "task_0");
    expect(evictedEntry).toMatchObject({ live: false });
  });

  it("does not report already-evicted entries again on subsequent opens", () => {
    const store = useWorkspace.getState();
    for (let i = 0; i < WORKSPACE_LRU_CAP + 1; i += 1) {
      store.openTask(`task_${i}`, 1_000 + i);
    }
    const second = store.openTask("task_more", 9_000);
    expect(second.evicted).toEqual(["task_1"]);
  });

  it("focusTask bumps recency and revives an evicted entry", () => {
    const store = useWorkspace.getState();
    for (let i = 0; i < WORKSPACE_LRU_CAP + 1; i += 1) {
      store.openTask(`task_${i}`, 1_000 + i);
    }
    store.focusTask("task_0", 9_999);
    const entries = useWorkspace.getState().entries;
    expect(entries[0]).toMatchObject({ taskId: "task_0", lastFocusedAt: 9_999, live: true });
  });

  it("focusTask on an unknown task is a no-op", () => {
    const store = useWorkspace.getState();
    store.openTask("task_a", 1_000);
    store.focusTask("task_unknown", 2_000);
    expect(useWorkspace.getState().entries.map((e) => e.taskId)).toEqual(["task_a"]);
  });

  it("closeTask removes the entry but keeps the persisted layout", () => {
    const store = useWorkspace.getState();
    store.openTask("task_a", 1_000);
    store.togglePanel("task_a", "editor", 2_000);
    store.closeTask("task_a");
    const state = useWorkspace.getState();
    expect(state.entries).toEqual([]);
    expect(state.layouts["task_a"]).toBeDefined();
  });
});

describe("panel layout mutations", () => {
  it("showing a panel with no size redistributes sizes equally among visible panels", () => {
    const store = useWorkspace.getState();
    store.togglePanel("task_a", "editor", 1_000);
    const layout = useWorkspace.getState().layouts["task_a"]!;
    expect(layout.visible.editor).toBe(true);
    expect(layout.sizes.terminal).toBe(50);
    expect(layout.sizes.editor).toBe(50);
    expect(layout.touchedAt).toBe(1_000);
  });

  it("hiding a panel retains its size so re-showing restores it without redistribution", () => {
    const store = useWorkspace.getState();
    store.togglePanel("task_a", "editor", 1_000);
    store.setPanelSizes(
      "task_a",
      { terminal: 70, editor: 30, git: 0, browser: 0, artifacts: 0, processes: 0 },
      2_000,
    );
    store.togglePanel("task_a", "editor", 3_000);
    let layout = useWorkspace.getState().layouts["task_a"]!;
    expect(layout.visible.editor).toBe(false);
    expect(layout.sizes.terminal).toBe(100);
    expect(layout.sizes.editor).toBe(30);

    store.togglePanel("task_a", "editor", 4_000);
    layout = useWorkspace.getState().layouts["task_a"]!;
    expect(layout.visible.editor).toBe(true);
    expect(layout.sizes).toMatchObject({ terminal: 70, editor: 30 });
  });

  it("clamps panel sizes to per-panel minimums at write time", () => {
    const store = useWorkspace.getState();
    store.togglePanel("task_a", "editor", 1_000);
    store.setPanelSizes(
      "task_a",
      { terminal: 5, editor: 10, git: 0, browser: 0, artifacts: 0, processes: 0 },
      2_000,
    );
    const layout = useWorkspace.getState().layouts["task_a"]!;
    expect(layout.sizes.terminal).toBe(PANEL_MIN_PCT.terminal);
    expect(layout.sizes.editor).toBe(PANEL_MIN_PCT.editor);
  });

  it("does not clamp hidden panels to visible minimums", () => {
    const store = useWorkspace.getState();
    store.setPanelSizes(
      "task_a",
      { terminal: 100, editor: 0, git: 0, browser: 0, artifacts: 0, processes: 0 },
      1_000,
    );
    const layout = useWorkspace.getState().layouts["task_a"]!;
    expect(layout.sizes.editor).toBe(0);
  });

  it("movePanel swaps with its neighbor and is a no-op at the edge", () => {
    const store = useWorkspace.getState();
    store.movePanel("task_a", "editor", "left", 1_000);
    let layout = useWorkspace.getState().layouts["task_a"]!;
    expect(layout.order[0]).toBe("editor");
    expect(layout.order[1]).toBe("terminal");

    store.movePanel("task_a", "editor", "left", 2_000);
    layout = useWorkspace.getState().layouts["task_a"]!;
    expect(layout.order[0]).toBe("editor");
    expect(layout.touchedAt).toBe(1_000);
  });

  it("layoutFor returns the default layout without mutating state", () => {
    const layout = useWorkspace.getState().layoutFor("task_missing");
    expect(layout.visible.terminal).toBe(true);
    expect(useWorkspace.getState().layouts).toEqual({});
  });

  it("layoutFor returns the stored layout when one exists", () => {
    const store = useWorkspace.getState();
    store.togglePanel("task_a", "git", 1_000);
    expect(store.layoutFor("task_a").visible.git).toBe(true);
  });
});

describe("persistence", () => {
  it("persists the updated layout on every mutation", async () => {
    const persistence = makePersistence();
    useWorkspace.getState().configure(persistence);
    useWorkspace.getState().togglePanel("task_a", "editor", 1_000);
    await flushMicrotasks();
    expect(persistence.saveLayout).toHaveBeenCalledTimes(1);
    const [taskKey, layout] = persistence.saveLayout.mock.calls[0] as [string, PanelLayout];
    expect(taskKey).toBe("task_a");
    expect(layout.visible.editor).toBe(true);
    expect(layout.touchedAt).toBe(1_000);

    useWorkspace
      .getState()
      .setPanelSizes(
        "task_a",
        { terminal: 60, editor: 40, git: 0, browser: 0, artifacts: 0, processes: 0 },
        2_000,
      );
    useWorkspace.getState().movePanel("task_a", "editor", "left", 3_000);
    await flushMicrotasks();
    expect(persistence.saveLayout).toHaveBeenCalledTimes(3);
  });

  it("can defer panel size persistence during resize previews until the final commit", async () => {
    const persistence = makePersistence();
    useWorkspace.getState().configure(persistence);
    useWorkspace.getState().togglePanel("task_a", "editor", 1_000);
    await flushMicrotasks();
    persistence.saveLayout.mockClear();

    useWorkspace
      .getState()
      .setPanelSizes(
        "task_a",
        { terminal: 65, editor: 35, git: 0, browser: 0, artifacts: 0, processes: 0 },
        2_000,
        { persist: false },
      );
    await flushMicrotasks();
    expect(useWorkspace.getState().layouts["task_a"]!.sizes).toMatchObject({
      terminal: 65,
      editor: 35,
    });
    expect(persistence.saveLayout).not.toHaveBeenCalled();

    useWorkspace
      .getState()
      .setPanelSizes(
        "task_a",
        { terminal: 65, editor: 35, git: 0, browser: 0, artifacts: 0, processes: 0 },
        3_000,
      );
    await flushMicrotasks();
    expect(persistence.saveLayout).toHaveBeenCalledTimes(1);
    const [taskKey, layout] = persistence.saveLayout.mock.calls[0] as [string, PanelLayout];
    expect(taskKey).toBe("task_a");
    expect(layout.sizes).toMatchObject({ terminal: 65, editor: 35 });
    expect(layout.touchedAt).toBe(3_000);
  });

  it("logs and does not throw when persistence fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const persistence = makePersistence();
      persistence.saveLayout.mockRejectedValue(new Error("disk full"));
      useWorkspace.getState().configure(persistence);
      expect(() => useWorkspace.getState().togglePanel("task_a", "editor", 1_000)).not.toThrow();
      await flushMicrotasks();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("hydrate merges persisted layouts under in-memory ones and only runs once", async () => {
    const persistedA = { ...defaultLayout(10), touchedAt: 10 };
    const persistedB = { ...defaultLayout(20), touchedAt: 20 };
    const persistence = makePersistence({ task_a: persistedA, task_b: persistedB });
    useWorkspace.getState().configure(persistence);

    useWorkspace.getState().togglePanel("task_a", "editor", 5_000);
    const inMemoryA = useWorkspace.getState().layouts["task_a"]!;

    await useWorkspace.getState().hydrate();
    const state = useWorkspace.getState();
    expect(state.hydrated).toBe(true);
    expect(state.layouts["task_a"]).toEqual(inMemoryA);
    expect(state.layouts["task_b"]).toEqual(persistedB);

    await useWorkspace.getState().hydrate();
    expect(persistence.loadLayouts).toHaveBeenCalledTimes(1);
  });

  it("normalizes legacy task layouts before exposing them to workspace panels", async () => {
    const legacy = {
      order: ["terminal", "editor"],
      visible: { terminal: true, editor: true },
      sizes: { terminal: 50, editor: 50 },
      touchedAt: 10,
    } as unknown as PanelLayout;
    useWorkspace.getState().configure(makePersistence({ task_legacy: legacy }));

    await useWorkspace.getState().hydrate();

    const hydrated = useWorkspace.getState().layouts.task_legacy!;
    expect(hydrated.order).toEqual(PANEL_KINDS);
    expect(hydrated.visible.timeline).toBe(false);
    expect(hydrated.sizes.timeline).toBe(0);
  });

  it("hydrate tolerates a load failure and still marks the store hydrated", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const persistence = makePersistence();
      persistence.loadLayouts.mockRejectedValue(new Error("ipc broken"));
      useWorkspace.getState().configure(persistence);
      await useWorkspace.getState().hydrate();
      expect(useWorkspace.getState().hydrated).toBe(true);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("state stays serializable (no Set/Map values)", () => {
    const store = useWorkspace.getState();
    store.openTask("task_a", 1_000);
    store.togglePanel("task_a", "editor", 2_000);
    const { entries, layouts, hydrated } = useWorkspace.getState();
    const roundTripped = JSON.parse(JSON.stringify({ entries, layouts, hydrated })) as {
      entries: unknown;
      layouts: unknown;
      hydrated: boolean;
    };
    expect(roundTripped.entries).toEqual(entries);
    expect(roundTripped.layouts).toEqual(layouts);
  });
});

describe("PANEL_MIN_PCT", () => {
  it("covers every panel kind", () => {
    for (const kind of PANEL_KINDS) {
      expect(PANEL_MIN_PCT[kind as PanelKind]).toBeGreaterThan(0);
    }
  });
});

describe("normalizeLayout (migration of older persisted layouts)", () => {
  it("appends panel kinds missing from a stale layout (hidden, zero size)", () => {
    // A layout saved before "timeline" existed.
    const stale: PanelLayout = {
      order: ["terminal", "editor"] as PanelKind[],
      visible: { terminal: true, editor: false } as Record<PanelKind, boolean>,
      sizes: { terminal: 100, editor: 0 } as Record<PanelKind, number>,
      touchedAt: 1,
    };
    const norm = normalizeLayout(stale);
    for (const kind of PANEL_KINDS) {
      expect(norm.order).toContain(kind);
      expect(typeof norm.visible[kind]).toBe("boolean");
      expect(typeof norm.sizes[kind]).toBe("number");
    }
    // Newly added kinds default to hidden so they don't disrupt the saved view.
    expect(norm.visible.timeline).toBe(false);
    // Existing values are preserved.
    expect(norm.visible.terminal).toBe(true);
    expect(norm.sizes.terminal).toBe(100);
  });

  it("drops unknown panel kinds from order", () => {
    const layout = { ...defaultLayout(1), order: ["terminal", "ghost", "editor"] as PanelKind[] };
    const norm = normalizeLayout(layout);
    expect(norm.order).not.toContain("ghost" as PanelKind);
    expect(norm.order).toContain("terminal");
  });

  it("is idempotent for a current default layout", () => {
    const def = defaultLayout(1);
    expect(normalizeLayout(def).order).toEqual(def.order);
  });
});
