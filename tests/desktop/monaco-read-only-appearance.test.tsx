// @vitest-environment jsdom

import React from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getThemeVariant, MONO_FONT_OPTIONS } from "@matrix-os/brand/themes";
import { monacoTheme } from "@matrix-os/brand/themes/editor";
import { MonacoReadOnlyEditor } from "@desktop/renderer/src/features/editor/MonacoReadOnlyEditor";
import { useAppearance } from "@desktop/renderer/src/stores/appearance";

const monaco = vi.hoisted(() => ({
  create: vi.fn(),
  defineTheme: vi.fn(),
  setTheme: vi.fn(),
}));
vi.mock("monaco-editor", () => ({ editor: monaco }));

type Options = { fontFamily: string; value: string; language: string; ariaLabel: string };
function makeEditor(options: Options) {
  const model = { value: options.value };
  const appliedOptions = { ...options };
  let scrollTop = 0;
  let selection = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 };
  return {
    options: appliedOptions,
    getModel: () => model,
    getScrollTop: () => scrollTop,
    setScrollTop: (value: number) => { scrollTop = value; },
    getSelection: () => selection,
    setSelection: (value: typeof selection) => { selection = value; },
    dispose: vi.fn(),
    updateOptions: vi.fn((value: Partial<Options>) => { Object.assign(appliedOptions, value); }),
  };
}

let editors: ReturnType<typeof makeEditor>[] = [];
const currentEditor = () => editors.at(-1)!;
const initialCustomTheme = {
  baseThemeId: "nord", light: { background: "#f4eedd" }, dark: { background: "#101820" },
};

async function expectCurrentAppearance() {
  const appearance = useAppearance.getState();
  await waitFor(() => {
    expect(monaco.defineTheme).toHaveBeenLastCalledWith(
      "matrix-appearance",
      monacoTheme(getThemeVariant(appearance.themeId, appearance.resolvedMode, appearance.customTheme), appearance.resolvedMode === "dark"),
    );
    expect(currentEditor().options.fontFamily).toBe(MONO_FONT_OPTIONS.find(font => font.id === appearance.monoFontId)!.family);
  });
}

describe("read-only Monaco appearance continuity", () => {
  beforeEach(() => {
    editors = [];
    vi.clearAllMocks();
    monaco.create.mockImplementation((_host: HTMLElement, options: Options) => {
      const editor = makeEditor(options);
      editors.push(editor);
      return editor;
    });
    vi.stubGlobal("Worker", class WorkerStub {});
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Matrix OS Electron");
    useAppearance.setState(useAppearance.getInitialState(), true);
    useAppearance.setState({ themeId: "matrix", resolvedMode: "light", monoFontId: "jetbrains", customTheme: null });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    useAppearance.setState(useAppearance.getInitialState(), true);
  });

  it.each(["font", "mode", "preset", "custom colors"] as const)("preserves model, scroll and selection when saving %s", async (change) => {
    if (change === "custom colors") useAppearance.setState({ themeId: "custom", customTheme: initialCustomTheme });
    render(<MonacoReadOnlyEditor path="src/app.ts" content="export const ready = true;" />);
    await waitFor(() => expect(monaco.create).toHaveBeenCalledTimes(1));
    const editor = currentEditor();
    const model = editor.getModel();
    const selection = { startLineNumber: 7, startColumn: 2, endLineNumber: 9, endColumn: 5 };
    editor.setScrollTop(480);
    editor.setSelection(selection);

    await act(async () => {
      if (change === "font") useAppearance.setState({ monoFontId: "system" });
      if (change === "mode") useAppearance.setState({ resolvedMode: "dark" });
      if (change === "preset") useAppearance.setState({ themeId: "nord" });
      if (change === "custom colors") useAppearance.setState({ customTheme: { ...initialCustomTheme, light: { background: "#e5d4b5" } } });
    });
    await expectCurrentAppearance();

    expect(currentEditor()).toBe(editor);
    expect(monaco.create).toHaveBeenCalledTimes(1);
    expect(editor.dispose).not.toHaveBeenCalled();
    expect(currentEditor().getModel()).toBe(model);
    expect(currentEditor().getScrollTop()).toBe(480);
    expect(currentEditor().getSelection()).toEqual(selection);
    expect(editor.updateOptions).toHaveBeenCalledWith({ fontFamily: currentEditor().options.fontFamily });
    expect(monaco.setTheme).toHaveBeenLastCalledWith("matrix-appearance");
  });

  it("initializes once with appearance changed before the module resolves", async () => {
    render(<MonacoReadOnlyEditor path="src/app.ts" content="text" />);
    await act(async () => { useAppearance.setState({ themeId: "nord", resolvedMode: "dark", monoFontId: "system" }); });
    await waitFor(() => expect(monaco.create).toHaveBeenCalledTimes(1));
    await expectCurrentAppearance();
    expect(currentEditor().dispose).not.toHaveBeenCalled();
  });

  it.each(["path", "content"] as const)("still replaces and disposes the old editor when %s changes", async (change) => {
    const view = render(<MonacoReadOnlyEditor path="src/app.ts" content="old" />);
    await waitFor(() => expect(monaco.create).toHaveBeenCalledTimes(1));
    const old = currentEditor();
    view.rerender(<MonacoReadOnlyEditor path={change === "path" ? "README.md" : "src/app.ts"} content={change === "content" ? "new" : "old"} />);
    await waitFor(() => expect(monaco.create).toHaveBeenCalledTimes(2));
    expect(old.dispose).toHaveBeenCalledTimes(1);
    expect(currentEditor().getModel()).not.toBe(old.getModel());
    expect(currentEditor().options).toMatchObject(change === "path" ? { language: "markdown", ariaLabel: "Preview README.md" } : { value: "new" });
  });

  it("disposes the retained editor once on unmount", async () => {
    const view = render(<MonacoReadOnlyEditor path="src/app.ts" content="text" />);
    await waitFor(() => expect(monaco.create).toHaveBeenCalledTimes(1));
    const editor = currentEditor();
    view.unmount();
    expect(editor.dispose).toHaveBeenCalledTimes(1);
  });

  it("handles asynchronous initialization failure without exposing its details", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    monaco.create.mockImplementationOnce(() => { throw new Error("private fixture detail"); });
    const view = render(<MonacoReadOnlyEditor path="src/app.ts" content="text" />);
    await waitFor(() => expect(warn).toHaveBeenCalledWith("[desktop-preview] Monaco initialization failed:", "Error"));
    expect(warn).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(monaco.setTheme).not.toHaveBeenCalled();
  });
});
