import { describe, expect, it } from "vitest";
import {
  beginFileDrag,
  createFileSelection,
  reconcileFileSelection,
  resetFileSelectionScope,
  updateFileSelection,
  type FileSelectionScope,
} from "@desktop/renderer/src/features/files/file-selection";

const scope: FileSelectionScope = { directory: "projects", runtimeSlot: "primary", authGeneration: 3 };
const order = ["projects/a", "projects/b", "projects/c", "projects/d"];

describe("file selection", () => {
  it("plain click selects exactly one and establishes anchor/focus", () => {
    const initial = createFileSelection(scope);
    const selected = updateFileSelection(initial, order, "projects/b", {}, "mac");
    const replaced = updateFileSelection(selected, order, "projects/d", {}, "mac");

    expect(replaced).toEqual({
      scope,
      selectedPaths: ["projects/d"],
      anchorPath: "projects/d",
      focusedPath: "projects/d",
    });
  });

  it("uses Command on macOS and Control on Windows/Linux for additive toggles", () => {
    const initial = updateFileSelection(createFileSelection(scope), order, "projects/a", {}, "mac");
    const mac = updateFileSelection(initial, order, "projects/c", { metaKey: true }, "mac");
    const windows = updateFileSelection(initial, order, "projects/c", { ctrlKey: true }, "windows");
    const linux = updateFileSelection(initial, order, "projects/c", { ctrlKey: true }, "linux");

    expect(mac.selectedPaths).toEqual(["projects/a", "projects/c"]);
    expect(windows.selectedPaths).toEqual(["projects/a", "projects/c"]);
    expect(linux.selectedPaths).toEqual(["projects/a", "projects/c"]);
    expect(updateFileSelection(mac, order, "projects/a", { metaKey: true }, "mac").selectedPaths).toEqual(["projects/c"]);
  });

  it("does not let the non-platform modifier accidentally toggle", () => {
    const initial = updateFileSelection(createFileSelection(scope), order, "projects/a", {}, "mac");
    expect(updateFileSelection(initial, order, "projects/c", { ctrlKey: true }, "mac").selectedPaths).toEqual(["projects/c"]);
    expect(updateFileSelection(initial, order, "projects/c", { metaKey: true }, "windows").selectedPaths).toEqual(["projects/c"]);
    expect(updateFileSelection(initial, order, "projects/c", { metaKey: true }, "linux").selectedPaths).toEqual(["projects/c"]);
  });

  it("plain Shift replaces with the inclusive anchor range", () => {
    const anchored = updateFileSelection(createFileSelection(scope), order, "projects/b", {}, "mac");
    const ranged = updateFileSelection(anchored, order, "projects/d", { shiftKey: true }, "mac");
    expect(ranged.selectedPaths).toEqual(["projects/b", "projects/c", "projects/d"]);
    expect(ranged.anchorPath).toBe("projects/b");
    expect(ranged.focusedPath).toBe("projects/d");
  });

  it("Shift plus the platform additive modifier unions the range in rendered order", () => {
    let state = updateFileSelection(createFileSelection(scope), order, "projects/a", {}, "windows");
    state = updateFileSelection(state, order, "projects/d", { ctrlKey: true }, "windows");
    const ranged = updateFileSelection(state, order, "projects/b", { shiftKey: true, ctrlKey: true }, "windows");
    expect(ranged.selectedPaths).toEqual(["projects/a", "projects/b", "projects/c", "projects/d"]);
    expect(ranged.anchorPath).toBe("projects/d");
  });

  it("falls back deterministically when the anchor vanished", () => {
    const stale = {
      ...createFileSelection(scope),
      selectedPaths: ["projects/a"],
      anchorPath: "projects/missing",
      focusedPath: "projects/a",
    };
    expect(updateFileSelection(stale, order, "projects/c", { shiftKey: true }, "mac")).toEqual({
      scope,
      selectedPaths: ["projects/c"],
      anchorPath: "projects/c",
      focusedPath: "projects/c",
    });
  });

  it("drags the selected siblings or first collapses an unselected row", () => {
    let state = updateFileSelection(createFileSelection(scope), order, "projects/a", {}, "mac");
    state = updateFileSelection(state, order, "projects/c", { metaKey: true }, "mac");

    expect(beginFileDrag(state, "projects/c")).toEqual({ state, dragPaths: ["projects/a", "projects/c"] });
    expect(beginFileDrag(state, "projects/b")).toEqual({
      state: { ...state, selectedPaths: ["projects/b"], anchorPath: "projects/b", focusedPath: "projects/b" },
      dragPaths: ["projects/b"],
    });
  });

  it("fails closed instead of creating a drag selection from another directory", () => {
    const state = updateFileSelection(createFileSelection(scope), order, "projects/a", {}, "mac");
    expect(beginFileDrag(state, "archive/a")).toEqual({ state, dragPaths: [] });
  });

  it("never admits another directory from a mixed rendered range", () => {
    const mixed = ["projects/a", "archive/foreign", "projects/c"];
    const anchored = updateFileSelection(createFileSelection(scope), mixed, "projects/a", {}, "mac");
    const ranged = updateFileSelection(anchored, mixed, "projects/c", { shiftKey: true }, "mac");
    expect(ranged.selectedPaths).toEqual(["projects/a", "projects/c"]);
  });

  it("keeps selections above the batch limit and refuses a partial drag", () => {
    const many = Array.from({ length: 140 }, (_, index) => `projects/${index.toString().padStart(3, "0")}`);
    const selected = updateFileSelection(
      { ...createFileSelection(scope), anchorPath: many[0] },
      many,
      many.at(-1)!,
      { shiftKey: true },
      "mac",
    );
    expect(selected.selectedPaths).toEqual(many);
    expect(beginFileDrag(selected, selected.selectedPaths[10]!)).toEqual({
      state: selected,
      dragPaths: [],
    });
  });

  it("caps serializable selection state at the bounded listing size", () => {
    const many = Array.from({ length: 1_100 }, (_, index) => `projects/${index.toString().padStart(4, "0")}`);
    const selected = updateFileSelection(
      { ...createFileSelection(scope), anchorPath: many[0] },
      many,
      many.at(-1)!,
      { shiftKey: true },
      "mac",
    );
    expect(selected.selectedPaths).toEqual(many.slice(0, 1_000));
  });

  it.each([
    [{ ...scope, directory: "archive" }, "navigation"],
    [{ ...scope, runtimeSlot: "preview" }, "runtime"],
    [{ ...scope, authGeneration: 4 }, "auth"],
  ] as const)("clears synchronously on %s scope changes", (nextScope) => {
    const selected = updateFileSelection(createFileSelection(scope), order, "projects/b", {}, "mac");
    expect(resetFileSelectionScope(selected, nextScope)).toEqual(createFileSelection(nextScope));
  });

  it("preserves selection when the scope is exactly unchanged", () => {
    const selected = updateFileSelection(createFileSelection(scope), order, "projects/b", {}, "mac");
    expect(resetFileSelectionScope(selected, { ...scope })).toBe(selected);
  });

  it("reconciles authoritative refresh in listing order and repairs anchor/focus", () => {
    const state = {
      ...createFileSelection(scope),
      selectedPaths: ["projects/c", "projects/a", "projects/missing"],
      anchorPath: "projects/missing",
      focusedPath: "projects/missing",
    };
    expect(reconcileFileSelection(state, scope, ["projects/b", "projects/a", "projects/c"])).toEqual({
      scope,
      selectedPaths: ["projects/a", "projects/c"],
      anchorPath: "projects/a",
      focusedPath: "projects/a",
    });
  });

  it("never retains paths while reconciling a different directory", () => {
    const state = updateFileSelection(createFileSelection(scope), order, "projects/a", {}, "mac");
    const nextScope = { ...scope, directory: "archive" };
    expect(reconcileFileSelection(state, nextScope, ["archive/a"])).toEqual(createFileSelection(nextScope));
  });
});
