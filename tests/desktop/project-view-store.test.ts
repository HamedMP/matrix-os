// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearProjectViewRuntime,
  MAX_PROJECT_VIEW_ENTRIES,
  useProjectView,
} from "../../desktop/src/renderer/src/stores/project-view";

const SCOPE = "operator|https://platform.test|primary";

function resetStore(): void {
  useProjectView.setState({ entries: {}, runtimeScope: null });
}

function mockOperator(stateValue: unknown = null) {
  const invoke = vi.fn(async (channel: string, payload: unknown) => {
    if (channel === "state:get") return { value: stateValue };
    if (channel === "state:set") return { ok: true };
    throw new Error(`unexpected channel ${channel}: ${JSON.stringify(payload)}`);
  });
  Object.defineProperty(window, "operator", {
    configurable: true,
    value: { invoke, on: vi.fn(() => () => undefined) },
  });
  return invoke;
}

describe("project view store", () => {
  beforeEach(() => {
    resetStore();
  });

  it("defaults every project to the board view with no thread selection", () => {
    expect(useProjectView.getState().viewFor("matrix-os")).toBe("board");
    expect(useProjectView.getState().selectedThreadFor("matrix-os")).toBeNull();
  });

  it("tracks the view per project independently", () => {
    useProjectView.getState().setView("matrix-os", "chats");
    useProjectView.getState().setView("website", "board");

    expect(useProjectView.getState().viewFor("matrix-os")).toBe("chats");
    expect(useProjectView.getState().viewFor("website")).toBe("board");
  });

  it("keeps the selected thread when switching views", () => {
    useProjectView.getState().setSelectedThread("matrix-os", "thread_alpha");
    useProjectView.getState().setView("matrix-os", "board");
    useProjectView.getState().setView("matrix-os", "chats");

    expect(useProjectView.getState().selectedThreadFor("matrix-os")).toBe("thread_alpha");
  });

  it("clears only the thread selection when asked", () => {
    useProjectView.getState().setView("matrix-os", "chats");
    useProjectView.getState().setSelectedThread("matrix-os", "thread_alpha");

    useProjectView.getState().setSelectedThread("matrix-os", null);

    expect(useProjectView.getState().selectedThreadFor("matrix-os")).toBeNull();
    expect(useProjectView.getState().viewFor("matrix-os")).toBe("chats");
  });

  it("persists the view state under the projectViews key once scoped", async () => {
    const invoke = mockOperator();
    await useProjectView.getState().hydrate(SCOPE);

    useProjectView.getState().setView("matrix-os", "chats");
    useProjectView.getState().setSelectedThread("matrix-os", "thread_alpha");

    await vi.waitFor(() => {
      const writes = invoke.mock.calls.filter(([channel]) => channel === "state:set");
      const write = writes.at(-1);
      expect(write).toBeTruthy();
      expect(write?.[1]).toMatchObject({ key: "projectViews" });
      const value = (write?.[1] as { value: { runtimeScope?: string; views: Record<string, unknown> } }).value;
      expect(value.runtimeScope).toBe(SCOPE);
      expect(value.views["matrix-os"]).toMatchObject({ view: "chats", selectedThreadId: "thread_alpha" });
      expect(value).not.toHaveProperty("summary");
      expect(value).not.toHaveProperty("transcript");
    });
  });

  it("restores persisted views for the same runtime scope", async () => {
    mockOperator({
      runtimeScope: SCOPE,
      views: {
        "matrix-os": { view: "chats", selectedThreadId: "thread_alpha", touchedAt: 10 },
      },
    });

    await useProjectView.getState().hydrate(SCOPE);

    expect(useProjectView.getState().viewFor("matrix-os")).toBe("chats");
    expect(useProjectView.getState().selectedThreadFor("matrix-os")).toBe("thread_alpha");
  });

  it("ignores persisted views from a different runtime scope", async () => {
    mockOperator({
      runtimeScope: "other|https://platform.test|primary",
      views: {
        "matrix-os": { view: "chats", selectedThreadId: "thread_alpha", touchedAt: 10 },
      },
    });

    await useProjectView.getState().hydrate(SCOPE);

    expect(useProjectView.getState().viewFor("matrix-os")).toBe("board");
    expect(useProjectView.getState().selectedThreadFor("matrix-os")).toBeNull();
  });

  it("keeps in-memory selections made before hydration finished", async () => {
    mockOperator({
      runtimeScope: SCOPE,
      views: {
        "matrix-os": { view: "board", selectedThreadId: null, touchedAt: 10 },
        website: { view: "chats", selectedThreadId: "thread_web", touchedAt: 9 },
      },
    });
    // A notification routed a chat open before the hydrate resolved.
    useProjectView.getState().setView("matrix-os", "chats");
    useProjectView.getState().setSelectedThread("matrix-os", "thread_clicked");

    await useProjectView.getState().hydrate(SCOPE);

    expect(useProjectView.getState().viewFor("matrix-os")).toBe("chats");
    expect(useProjectView.getState().selectedThreadFor("matrix-os")).toBe("thread_clicked");
    expect(useProjectView.getState().viewFor("website")).toBe("chats");
  });

  it("evicts the least recently touched projects beyond the cap", () => {
    for (let index = 0; index < MAX_PROJECT_VIEW_ENTRIES + 5; index += 1) {
      useProjectView.getState().setView(`project-${index}`, "chats");
    }
    // Touch an early project so it is no longer the coldest.
    useProjectView.getState().setView("project-0", "board");

    const entries = Object.keys(useProjectView.getState().entries);
    expect(entries.length).toBeLessThanOrEqual(MAX_PROJECT_VIEW_ENTRIES);
    expect(entries).toContain("project-0");
    expect(entries).not.toContain("project-1");
  });

  it("resets all entries on runtime change", () => {
    useProjectView.getState().setView("matrix-os", "chats");
    useProjectView.getState().setSelectedThread("matrix-os", "thread_alpha");

    clearProjectViewRuntime();

    expect(useProjectView.getState().entries).toEqual({});
    expect(useProjectView.getState().viewFor("matrix-os")).toBe("board");
  });
});
