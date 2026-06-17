// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MonacoHost from "@desktop/renderer/src/features/editor/MonacoHost";
import type { ApiClient } from "@desktop/renderer/src/lib/api";
import { useConnection } from "@desktop/renderer/src/stores/connection";

const monacoHarness = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let value = "";
  let currentModel: {
    getValue: () => string;
    setValue: (next: string) => void;
    onDidChangeContent: (listener: () => void) => { dispose: () => void };
    isDisposed: () => boolean;
    dispose: () => void;
  };

  const reset = () => {
    listeners.clear();
    value = "";
    currentModel = {
      getValue: () => value,
      setValue: (next: string) => {
        value = next;
        for (const listener of listeners) listener();
      },
      onDidChangeContent: (listener: () => void) => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
      isDisposed: () => false,
      dispose: vi.fn(),
    };
  };

  reset();

  const editor = {
    getValue: () => currentModel.getValue(),
    getModel: () => currentModel,
    setModel: vi.fn((model: typeof currentModel) => {
      currentModel = model;
    }),
    dispose: vi.fn(),
  };

  return { editor, model: () => currentModel, reset };
});

vi.mock("monaco-editor", () => ({
  editor: {
    create: vi.fn(() => monacoHarness.editor),
    createModel: vi.fn((content: string) => {
      monacoHarness.model().setValue(content);
      return monacoHarness.model();
    }),
    defineTheme: vi.fn(),
  },
  Uri: {
    file: vi.fn((path: string) => ({ path })),
  },
}), { virtual: true });

vi.mock("monaco-editor/esm/vs/editor/editor.worker?worker", () => ({ default: class Worker {} }), { virtual: true });
vi.mock("monaco-editor/esm/vs/language/json/json.worker?worker", () => ({ default: class Worker {} }), { virtual: true });
vi.mock("monaco-editor/esm/vs/language/css/css.worker?worker", () => ({ default: class Worker {} }), { virtual: true });
vi.mock("monaco-editor/esm/vs/language/html/html.worker?worker", () => ({ default: class Worker {} }), { virtual: true });
vi.mock("monaco-editor/esm/vs/language/typescript/ts.worker?worker", () => ({
  default: class Worker {},
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
  render(<MonacoHost taskId="task-1" path="projects/notes.md" />);
  await waitFor(() => expect(monacoHarness.editor.setModel).toHaveBeenCalled());

  act(() => {
    monacoHarness.model().setValue("local edit");
  });
  fireEvent.keyDown(window, { key: "s", ctrlKey: true });
  await screen.findByText("This file changed on your computer since you opened it.");
}

describe("MonacoHost conflict actions", () => {
  beforeEach(() => {
    monacoHarness.reset();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
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
