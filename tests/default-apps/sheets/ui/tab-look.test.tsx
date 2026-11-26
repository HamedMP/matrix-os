// @vitest-environment jsdom
/**
 * Tab order and colours follow the workbook when it gets a path: chosen
 * before the first save, they are stored under the path that save gives;
 * kept while saving a copy, they are stored under the copy's path.
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EMPTY_LOOK, TAB_LOOK_KEY, type TabLook, TabLookStore } from "../../../../home/apps/sheets/src/ui/sheet-tabs-model";
import { useTabLook } from "../../../../home/apps/sheets/src/ui/tab-look";

afterEach(cleanup);

function memoryStore(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial };
  const store = new TabLookStore({ readData: async (key) => data[key], writeData: async (key, value) => void (data[key] = value) });
  return { store, data };
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

const LOOK: TabLook = { order: ["b", "a"], colors: { a: "red" } };

describe("tab order and colours of a workbook that gets a path", () => {
  // Outcome: tabs arranged in a new workbook come back after it is saved and reopened.
  // Fault: the choice was kept on screen when the first save supplied a path but never stored under it.
  it("stores choices made before the first save under the path that save gives", async () => {
    const { store } = memoryStore();
    const view = renderHook(({ path }) => useTabLook(store, path), { initialProps: { path: null as string | null } });
    act(() => view.result.current[1](LOOK));
    expect(view.result.current[0]).toEqual(LOOK);

    view.rerender({ path: "Documents/Plan.xlsx" });
    await settle();
    expect(view.result.current[0]).toEqual(LOOK);
    expect(await store.load("Documents/Plan.xlsx")).toEqual(LOOK);
  });

  it("keeps the choices of a workbook saved as a copy, and stores them under the copy", async () => {
    const { store } = memoryStore({ [TAB_LOOK_KEY]: { files: [{ path: "A.xlsx", order: ["b", "a"], colors: { a: "red" }, at: 1 }] } });
    const view = renderHook(({ path }) => useTabLook(store, path), { initialProps: { path: "A.xlsx" as string | null } });
    await settle();
    expect(view.result.current[0]).toEqual(LOOK);

    view.rerender({ path: "A copy.xlsx" });
    await settle();
    expect(view.result.current[0]).toEqual(LOOK);
    expect(await store.load("A copy.xlsx")).toEqual(LOOK);
  });

  it("keeps a choice made while the stored one loads", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const data: Record<string, unknown> = { [TAB_LOOK_KEY]: { files: [{ path: "A.xlsx", order: ["a"], colors: {}, at: 1 }] } };
    const store = new TabLookStore({
      readData: async (key) => {
        await gate;
        return data[key];
      },
      writeData: async (key, value) => void (data[key] = value),
    });
    const view = renderHook(() => useTabLook(store, "A.xlsx"));
    expect(view.result.current[0]).toEqual(EMPTY_LOOK);
    act(() => view.result.current[1](LOOK));
    release();
    await settle();
    expect(view.result.current[0]).toEqual(LOOK);
  });
});
