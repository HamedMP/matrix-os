// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MonacoEditorHost, { MAX_MONACO_FILE_BYTES } from "@desktop/renderer/src/features/editor/MonacoEditorHost";
import { useConnection } from "@desktop/renderer/src/stores/connection";

import { useAppearance } from "@desktop/renderer/src/stores/appearance";

const monacoMocks = vi.hoisted(() => ({
  create: vi.fn(() => {
    throw new Error("monaco failed to initialize");
  }),
  createModel: vi.fn(() => ({ dispose: vi.fn() })),
}));

vi.mock("../../desktop/node_modules/monaco-editor", () => ({
  editor: {
    create: monacoMocks.create,
    createModel: monacoMocks.createModel,
    defineTheme: vi.fn(),
    setTheme: vi.fn(),
  },
}));

function makeApi() {
  const get = vi.fn(async () => ({ modified: "2026-08-29T10:00:00.000Z" }));
  const getText = vi.fn(async () => "export const value = 1;\n");
  const putText = vi.fn(async () => ({ modified: "2026-08-29T10:01:00.000Z" }));
  return { get, getText, putText, baseUrl: "https://app.matrix-os.com" };
}

describe("MonacoEditorHost", () => {
  it("edits the exact project worktree and saves against its current etag", async () => {
    const api = makeApi(); useConnection.setState({ api: api as never });
    const resource = { kind: "project" as const, projectId: "project-one", worktreeId: "wt_one", path: "guide.md" };
    const invoke = vi.fn(async (channel: string) => channel === "runtime:get-file-content"
      ? { metadata: { etag: "etag_1" }, content: "# Project guide", truncated: false }
      : { metadata: { etag: "etag_2" } });
    Object.defineProperty(window, "operator", { configurable: true, value: { invoke } });
    render(<MonacoEditorHost path="guide.md" resource={resource} active onDirtyChange={vi.fn()} />);
    const editor = await screen.findByRole("textbox", { name: "Edit guide.md" });
    expect((editor as HTMLTextAreaElement).value).toBe("# Project guide");
    fireEvent.change(editor, { target: { value: "# Updated guide" } });
    fireEvent.click(screen.getByRole("button", { name: "Save guide.md" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("runtime:save-file-content", expect.objectContaining({ projectId: "project-one", worktreeId: "wt_one", path: "guide.md", baseEtag: "etag_1", content: "# Updated guide" })));
    expect(api.putText).not.toHaveBeenCalled();
  });
  it("does not overwrite a changed project file and preserves the local buffer", async () => {
    useConnection.setState({ api: makeApi() as never });
    const resource = { kind: "project" as const, projectId: "project-one", worktreeId: "wt_one", path: "guide.md" };
    const invoke = vi.fn().mockResolvedValueOnce({ metadata: { etag: "etag_1" }, content: "# First", truncated: false })
      .mockResolvedValue({ metadata: { etag: "etag_2" }, content: "# Changed elsewhere", truncated: false });
    Object.defineProperty(window, "operator", { configurable: true, value: { invoke } });
    render(<MonacoEditorHost path="guide.md" resource={resource} active onDirtyChange={vi.fn()} />);
    const editor = await screen.findByRole("textbox", { name: "Edit guide.md" });
    fireEvent.change(editor, { target: { value: "# Local unsaved" } });
    fireEvent.keyDown(window, { key: "s", metaKey: true });
    await screen.findByText(/changed on your computer/i);
    expect((editor as HTMLTextAreaElement).value).toBe("# Local unsaved");
    expect(invoke.mock.calls.some(([channel]) => channel === "runtime:save-file-content")).toBe(false);
  });
  it("previews unsaved Markdown beside the editor without writing it", async () => {
    const api = makeApi();
    api.getText.mockResolvedValue("# Original\n");
    useConnection.setState({ api: api as never });
    render(<MonacoEditorHost path="notes/plan.md" active onDirtyChange={vi.fn()} />);
    const editor = await screen.findByRole("textbox", { name: "Edit notes/plan.md" });
    fireEvent.change(editor, { target: { value: "# Unsaved heading\n\n- First action" } });
    fireEvent.click(screen.getByRole("button", { name: "Split Markdown view" }));
    expect(await screen.findByRole("heading", { name: "Unsaved heading" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Edit notes/plan.md" })).toBeTruthy();
    expect(api.putText).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Markdown source" }));
    expect(screen.getByRole("textbox").getAttribute("value") ?? (screen.getByRole("textbox") as HTMLTextAreaElement).value).toContain("Unsaved heading");
  });
  beforeEach(() => {
    useConnection.setState(useConnection.getInitialState(), true);
    useConnection.setState({ runtimeSlot: "primary", authGeneration: 1 });
  });

  afterEach(() => cleanup());

  it("loads with a transfer cap, edits, and saves through the conflict-safe file API", async () => {
    const api = makeApi();
    useConnection.setState({ api: api as never });
    const onDirtyChange = vi.fn();
    render(<MonacoEditorHost path="projects/app/src/main.ts" active onDirtyChange={onDirtyChange} />);

    const editor = await screen.findByRole("textbox", { name: "Edit projects/app/src/main.ts" });
    expect(api.getText).toHaveBeenCalledWith(
      "/api/files/blob?path=projects%2Fapp%2Fsrc%2Fmain.ts",
      { maxBytes: MAX_MONACO_FILE_BYTES },
    );
    fireEvent.change(editor, { target: { value: "export const value = 2;\n" } });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    fireEvent.keyDown(window, { key: "s", metaKey: true });

    await waitFor(() => expect(api.putText).toHaveBeenCalledWith(
      "/api/files/blob?path=projects%2Fapp%2Fsrc%2Fmain.ts&force=true",
      "export const value = 2;\n",
    ));
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it("does not continue a save against a replacement runtime session", async () => {
    let resolveSaveStat!: (value: { modified: string }) => void;
    const saveStat = new Promise<{ modified: string }>((resolve) => { resolveSaveStat = resolve; });
    const api = makeApi();
    api.get
      .mockResolvedValueOnce({ modified: "2026-08-29T10:00:00.000Z" })
      .mockImplementationOnce(() => saveStat);
    useConnection.setState({ api: api as never });
    render(<MonacoEditorHost path="projects/app/src/main.ts" active onDirtyChange={vi.fn()} />);

    const editor = await screen.findByRole("textbox", { name: "Edit projects/app/src/main.ts" });
    fireEvent.change(editor, { target: { value: "changed" } });
    fireEvent.keyDown(window, { key: "s", metaKey: true });
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));

    await act(async () => {
      useConnection.setState({ authGeneration: 2 });
      resolveSaveStat({ modified: "2026-08-29T10:00:00.000Z" });
      await Promise.resolve();
    });

    expect(api.putText).not.toHaveBeenCalled();
  });

  it("keeps loaded file content visible when Monaco cannot initialize", async () => {
    const originalWorker = globalThis.Worker;
    const originalUserAgent = navigator.userAgent;
    Object.defineProperty(globalThis, "Worker", { configurable: true, value: class WorkerStub {} });
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: "Matrix OS Electron" });
    try {
      const api = makeApi();
      useConnection.setState({ api: api as never });

      render(<MonacoEditorHost path="projects/app/src/main.ts" active onDirtyChange={vi.fn()} />);

      await waitFor(() => expect(document.querySelector("[data-monaco-state=failed]")).toBeTruthy(), { timeout: 10000 });
      const fallback = await screen.findByRole("textbox", { name: "Edit projects/app/src/main.ts" });
      expect((fallback as HTMLTextAreaElement).value).toBe("export const value = 1;\n");
    } finally {
      Object.defineProperty(globalThis, "Worker", { configurable: true, value: originalWorker });
      Object.defineProperty(navigator, "userAgent", { configurable: true, value: originalUserAgent });
    }
  });
  it('updates typography and palette without replacing the model or editor', async () => {
    const originalWorker = globalThis.Worker;
    const originalUserAgent = navigator.userAgent;
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: class WorkerStub {} });
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Matrix OS Electron' });
    const editor = { dispose: vi.fn(), updateOptions: vi.fn(), onDidChangeModelContent: vi.fn(), getValue: () => 'text' };
    monacoMocks.create.mockReturnValueOnce(editor as never);
    monacoMocks.createModel.mockClear();
    useAppearance.setState({ themeId: 'matrix', resolvedMode: 'light', monoFontId: 'jetbrains', customTheme: null });
    try {
      useConnection.setState({ api: makeApi() as never });
      render(<MonacoEditorHost path='projects/main.ts' active onDirtyChange={vi.fn()} />);
      await waitFor(() => expect(monacoMocks.createModel).toHaveBeenCalledTimes(1), { timeout: 10000 });
      await act(async () => { useAppearance.setState({ monoFontId: 'system', themeId: 'nord', resolvedMode: 'dark' }); });
      await waitFor(() => expect(editor.updateOptions).toHaveBeenCalledWith(expect.objectContaining({ fontFamily: expect.stringContaining('ui-monospace') })));
      expect(monacoMocks.createModel).toHaveBeenCalledTimes(1);
      expect(editor.dispose).not.toHaveBeenCalled();
    } finally {
      cleanup();
      Object.defineProperty(globalThis, 'Worker', { configurable: true, value: originalWorker });
      Object.defineProperty(navigator, 'userAgent', { configurable: true, value: originalUserAgent });
    }
  });

});
