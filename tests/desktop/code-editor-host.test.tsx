// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CodeMirrorHost from "@desktop/renderer/src/features/editor/CodeMirrorHost";
import type { ApiClient } from "@desktop/renderer/src/lib/api";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { useEditorTabs } from "@desktop/renderer/src/features/editor/editor-tabs-store";

const editorHarness = vi.hoisted(() => {
  type FakeDoc = {
    length: number;
    toString: () => string;
  };
  type FakeState = { doc: FakeDoc; extensions: unknown[] };
  type UpdateListener = (update: { docChanged: boolean; state: FakeState }) => void;

  let view: { state: FakeState; dispatch: (spec: { changes: { insert: string } }) => void } | null = null;
  const listeners: UpdateListener[] = [];

  const makeDoc = (content: string): FakeDoc => ({
    length: content.length,
    toString: () => content,
  });

  const reset = () => {
    view = null;
    listeners.length = 0;
  };

  return {
    listeners,
    makeDoc,
    reset,
    get view() {
      return view;
    },
    setView(next: typeof view) {
      view = next;
    },
  };
});

vi.mock("@codemirror/commands", () => ({
  defaultKeymap: [],
  history: vi.fn(() => []),
  historyKeymap: [],
}), { virtual: true });
vi.mock("@codemirror/lang-css", () => ({ css: vi.fn(() => []) }), { virtual: true });
vi.mock("@codemirror/lang-html", () => ({ html: vi.fn(() => []) }), { virtual: true });
vi.mock("@codemirror/lang-javascript", () => ({ javascript: vi.fn(() => []) }), { virtual: true });
vi.mock("@codemirror/lang-json", () => ({ json: vi.fn(() => []) }), { virtual: true });
vi.mock("@codemirror/lang-markdown", () => ({ markdown: vi.fn(() => []) }), { virtual: true });
vi.mock("@codemirror/lang-python", () => ({ python: vi.fn(() => []) }), { virtual: true });
vi.mock("@codemirror/search", () => ({
  highlightSelectionMatches: vi.fn(() => []),
  searchKeymap: [],
}), { virtual: true });
vi.mock("@codemirror/state", () => ({
  EditorState: {
    create: vi.fn(({ doc, extensions }: { doc: string; extensions: unknown[] }) => ({
      doc: editorHarness.makeDoc(doc),
      extensions,
    })),
  },
}), { virtual: true });
vi.mock("@codemirror/theme-one-dark", () => ({ oneDark: [] }), { virtual: true });
vi.mock("@codemirror/view", () => ({
  EditorView: class FakeEditorView {
    static updateListener = {
      of: (listener: (update: { docChanged: boolean; state: unknown }) => void) => {
        editorHarness.listeners.push(listener as never);
        return listener;
      },
    };
    static theme = vi.fn(() => []);
    state: { doc: { length: number; toString: () => string }; extensions: unknown[] };

    constructor({ state }: { state: { doc: { length: number; toString: () => string }; extensions: unknown[] } }) {
      this.state = state;
      editorHarness.setView(this);
    }

    dispatch({ changes }: { changes: { insert: string } }) {
      this.state = { ...this.state, doc: editorHarness.makeDoc(changes.insert) };
      for (const listener of editorHarness.listeners) listener({ docChanged: true, state: this.state });
    }

    destroy() {
      editorHarness.setView(null);
    }
  },
  highlightActiveLine: vi.fn(() => []),
  keymap: { of: vi.fn(() => []) },
  lineNumbers: vi.fn(() => []),
}), { virtual: true });

const OLD_MODIFIED = "2026-06-13T10:00:00.000Z";
const NEW_MODIFIED = "2026-06-13T10:01:00.000Z";

function wireStat(modified: string): Record<string, unknown> {
  return {
    name: "notes.md",
    path: "projects/notes.md",
    type: "file",
    size: 42,
    modified,
    created: "2026-06-01T00:00:00.000Z",
    mime: "text/markdown",
  };
}

function makeApi(overrides: Partial<ApiClient>): ApiClient {
  return {
    baseUrl: "https://x.test",
    get: vi.fn(),
    getText: vi.fn().mockResolvedValue("server body"),
    post: vi.fn().mockResolvedValue({}),
    patch: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({ ok: true }),
    putText: vi.fn().mockResolvedValue({ ok: true, modified: NEW_MODIFIED }),
    ...overrides,
  } as ApiClient;
}

async function renderConflict(api: ApiClient) {
  useConnection.setState({
    status: "signed-in",
    handle: "operator",
    platformHost: "https://x.test",
    runtimeSlot: "primary",
    api,
  });
  render(<CodeMirrorHost taskId="task-1" path="projects/notes.md" />);
  await waitFor(() => expect(editorHarness.view).not.toBeNull());

  act(() => {
    editorHarness.view?.dispatch({ changes: { insert: "local edit" } });
  });
  fireEvent.keyDown(window, { key: "s", ctrlKey: true });
  await screen.findByText("This file changed on your computer since you opened it.");
}

describe("CodeMirrorHost conflict actions", () => {
  beforeEach(() => {
    editorHarness.reset();
  });

  afterEach(() => {
    cleanup();
    useEditorTabs.setState({ tabsByTask: {}, activePathByTask: {}, dirtyPathsByTask: {} });
    vi.restoreAllMocks();
  });

  it("preserves unsaved edits across editor remounts", async () => {
    const api = makeApi({
      get: vi.fn().mockResolvedValue(wireStat(OLD_MODIFIED)),
      getText: vi.fn().mockResolvedValue("server body"),
    });
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      platformHost: "https://x.test",
      runtimeSlot: "primary",
      api,
    });

    const { unmount } = render(<CodeMirrorHost taskId="task-cache" path="projects/draft.md" />);
    await waitFor(() => expect(editorHarness.view).not.toBeNull());

    act(() => {
      editorHarness.view?.dispatch({ changes: { insert: "unsaved local edit" } });
    });
    expect(useEditorTabs.getState().dirtyPathsByTask["task-cache"]).toContain("projects/draft.md");

    unmount();
    render(<CodeMirrorHost taskId="task-cache" path="projects/draft.md" />);
    await waitFor(() => expect(editorHarness.view).not.toBeNull());

    expect(editorHarness.view?.state.doc.toString()).toBe("unsaved local edit");
    expect(useEditorTabs.getState().dirtyPathsByTask["task-cache"]).toContain("projects/draft.md");
  });

  it("ignores a second overwrite click while the first overwrite is pending", async () => {
    const api = makeApi({
      get: vi.fn()
        .mockResolvedValueOnce(wireStat(OLD_MODIFIED))
        .mockResolvedValueOnce(wireStat(NEW_MODIFIED)),
      putText: vi.fn(() => new Promise(() => undefined)),
    });
    await renderConflict(api);

    fireEvent.click(screen.getByRole("button", { name: "Overwrite" }));
    fireEvent.click(screen.getByRole("button", { name: "Overwrite" }));

    expect(api.putText).toHaveBeenCalledTimes(1);
  });

  it("ignores a second reload click while the first reload is pending", async () => {
    const api = makeApi({
      get: vi.fn()
        .mockResolvedValueOnce(wireStat(OLD_MODIFIED))
        .mockResolvedValueOnce(wireStat(NEW_MODIFIED))
        .mockImplementationOnce(() => new Promise(() => undefined)),
    });
    await renderConflict(api);

    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));

    expect(api.get).toHaveBeenCalledTimes(3);
  });
});
