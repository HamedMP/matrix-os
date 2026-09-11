// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MonacoEditorHost, { MAX_MONACO_FILE_BYTES } from "@desktop/renderer/src/features/editor/MonacoEditorHost";
import { useConnection } from "@desktop/renderer/src/stores/connection";

const monacoMocks = vi.hoisted(() => ({
  create: vi.fn(() => {
    throw new Error("monaco failed to initialize");
  }),
  createModel: vi.fn(() => ({ dispose: vi.fn() })),
}));

vi.mock("monaco-editor", () => ({
  editor: {
    create: monacoMocks.create,
    createModel: monacoMocks.createModel,
  },
}));

function makeApi() {
  const get = vi.fn(async () => ({ modified: "2026-08-29T10:00:00.000Z" }));
  const getText = vi.fn(async () => "export const value = 1;\n");
  const putText = vi.fn(async () => ({ modified: "2026-08-29T10:01:00.000Z" }));
  return { get, getText, putText, baseUrl: "https://app.matrix-os.com" };
}

describe("MonacoEditorHost", () => {
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

      const fallback = await screen.findByRole("textbox", { name: "Edit projects/app/src/main.ts" });
      expect((fallback as HTMLTextAreaElement).value).toBe("export const value = 1;\n");
    } finally {
      Object.defineProperty(globalThis, "Worker", { configurable: true, value: originalWorker });
      Object.defineProperty(navigator, "userAgent", { configurable: true, value: originalUserAgent });
    }
  });
});
