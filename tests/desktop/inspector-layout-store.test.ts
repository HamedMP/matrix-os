// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_INSPECTOR_WIDTH_PCT,
  INSPECTOR_LAYOUT_PREFIX,
  MAX_INSPECTOR_WIDTH_PCT,
  MIN_INSPECTOR_WIDTH_PCT,
  useInspectorLayout,
} from "../../desktop/src/renderer/src/features/panels/inspector-layout-store";

interface CapturedLayout {
  order: string[];
  visible: Record<string, boolean>;
  sizes: Record<string, number>;
  touchedAt: number;
}

function mockOperator(stored: Record<string, CapturedLayout> = {}) {
  const saved: Array<{ taskKey: string; layout: CapturedLayout }> = [];
  const invoke = vi.fn(async (channel: string, payload: unknown) => {
    if (channel === "state:get") return { value: stored };
    if (channel === "state:set-panel-layout") {
      saved.push(payload as { taskKey: string; layout: CapturedLayout });
      return { ok: true };
    }
    throw new Error(`unexpected channel ${channel}`);
  });
  Object.defineProperty(window, "operator", {
    configurable: true,
    value: { invoke, on: vi.fn(() => () => undefined) },
  });
  return { invoke, saved };
}

function persistedLayout(widthPct: number, collapsed: boolean): CapturedLayout {
  return {
    order: ["conversation", "inspector"],
    visible: { conversation: true, inspector: !collapsed },
    sizes: { conversation: 100 - widthPct, inspector: widthPct },
    touchedAt: 1,
  };
}

describe("inspector-layout-store", () => {
  beforeEach(() => {
    useInspectorLayout.setState({ entries: {}, runtimeScope: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults to an expanded inspector at the default width", () => {
    expect(useInspectorLayout.getState().layoutFor("matrix-os")).toEqual({
      widthPct: DEFAULT_INSPECTOR_WIDTH_PCT,
      collapsed: false,
    });
  });

  it("persists the width through the existing panel-layout channel", async () => {
    const { saved } = mockOperator();
    useInspectorLayout.getState().setWidthPct("matrix-os", 42);

    expect(useInspectorLayout.getState().layoutFor("matrix-os").widthPct).toBe(42);
    await vi.waitFor(() => expect(saved.length).toBe(1));
    expect(saved[0]!.taskKey).toBe(`${INSPECTOR_LAYOUT_PREFIX}matrix-os`);
    expect(saved[0]!.layout.sizes).toEqual({ conversation: 58, inspector: 42 });
    expect(saved[0]!.layout.visible).toEqual({ conversation: true, inspector: true });
  });

  it("clamps the width to the supported range", () => {
    mockOperator();
    useInspectorLayout.getState().setWidthPct("matrix-os", 5);
    expect(useInspectorLayout.getState().layoutFor("matrix-os").widthPct).toBe(MIN_INSPECTOR_WIDTH_PCT);
    useInspectorLayout.getState().setWidthPct("matrix-os", 95);
    expect(useInspectorLayout.getState().layoutFor("matrix-os").widthPct).toBe(MAX_INSPECTOR_WIDTH_PCT);
  });

  it("keeps the last width when collapsing so re-expand restores it", async () => {
    const { saved } = mockOperator();
    useInspectorLayout.getState().setWidthPct("matrix-os", 40);
    useInspectorLayout.getState().setCollapsed("matrix-os", true);

    const entry = useInspectorLayout.getState().layoutFor("matrix-os");
    expect(entry).toEqual({ widthPct: 40, collapsed: true });
    await vi.waitFor(() => expect(saved.length).toBe(2));
    // The envelope still carries the width so expansion restores it.
    expect(saved[1]!.layout.visible).toEqual({ conversation: true, inspector: false });
    expect(saved[1]!.layout.sizes.inspector).toBe(40);

    useInspectorLayout.getState().setCollapsed("matrix-os", false);
    expect(useInspectorLayout.getState().layoutFor("matrix-os")).toEqual({ widthPct: 40, collapsed: false });
  });

  it("hydrates persisted entries and ignores foreign or invalid layouts", async () => {
    mockOperator({
      [`${INSPECTOR_LAYOUT_PREFIX}matrix-os`]: persistedLayout(45, false),
      [`${INSPECTOR_LAYOUT_PREFIX}website`]: persistedLayout(25, true),
      "some-task": persistedLayout(50, false),
      [`${INSPECTOR_LAYOUT_PREFIX}broken`]: { order: [], visible: {}, sizes: { inspector: Number.NaN }, touchedAt: 1 },
    });

    await useInspectorLayout.getState().hydrate("scope-a");

    expect(useInspectorLayout.getState().layoutFor("matrix-os")).toEqual({ widthPct: 45, collapsed: false });
    expect(useInspectorLayout.getState().layoutFor("website")).toEqual({ widthPct: 25, collapsed: true });
    expect(useInspectorLayout.getState().layoutFor("some-task")).toEqual({
      widthPct: DEFAULT_INSPECTOR_WIDTH_PCT,
      collapsed: false,
    });
    expect(useInspectorLayout.getState().layoutFor("broken")).toEqual({
      widthPct: DEFAULT_INSPECTOR_WIDTH_PCT,
      collapsed: false,
    });
  });

  it("re-reads when the runtime scope changes and keeps in-memory writes", async () => {
    const first = mockOperator({ [`${INSPECTOR_LAYOUT_PREFIX}matrix-os`]: persistedLayout(45, false) });
    await useInspectorLayout.getState().hydrate("scope-a");
    expect(useInspectorLayout.getState().layoutFor("matrix-os").widthPct).toBe(45);

    // A write after hydration is newer than anything a later read returns.
    useInspectorLayout.getState().setWidthPct("matrix-os", 30);
    Object.defineProperty(window, "operator", {
      configurable: true,
      value: { invoke: first.invoke, on: vi.fn(() => () => undefined) },
    });
    await useInspectorLayout.getState().hydrate("scope-b");

    expect(first.invoke.mock.calls.filter(([channel]) => channel === "state:get").length).toBe(2);
    expect(useInspectorLayout.getState().layoutFor("matrix-os").widthPct).toBe(30);
  });
});
