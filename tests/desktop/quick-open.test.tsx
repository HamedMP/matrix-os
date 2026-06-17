// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import QuickOpen from "../../desktop/src/renderer/src/features/files/QuickOpen";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useUi } from "../../desktop/src/renderer/src/stores/ui";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";
import { useEditorTabs } from "../../desktop/src/renderer/src/features/editor/editor-tabs-store";
import { useWorkspace } from "../../desktop/src/renderer/src/stores/workspace";

async function searchForFile(path: string): Promise<void> {
  fireEvent.change(screen.getByPlaceholderText(/go to file/i), { target: { value: path } });
  await act(async () => {
    vi.advanceTimersByTime(150);
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("QuickOpen", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useConnection.setState({
      api: {
        get: vi.fn().mockResolvedValue({ results: ["src/app.ts"] }),
      } as never,
    });
    useUi.setState({
      createTaskOpen: false,
      composerOpen: false,
      paletteOpen: false,
      quickOpenOpen: true,
    });
    useTabs.setState(useTabs.getInitialState(), true);
    useEditorTabs.setState(useEditorTabs.getInitialState(), true);
    useWorkspace.setState(useWorkspace.getInitialState(), true);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps the dialog open with feedback when opening outside a task", async () => {
    render(<QuickOpen />);

    await searchForFile("app");
    fireEvent.click(screen.getByRole("button", { name: /src\/app\.ts/i }));

    expect(screen.getByRole("status").textContent).toContain("Open a task tab");
    expect(useUi.getState().quickOpenOpen).toBe(true);
    expect(useEditorTabs.getState().activePathByTask).toEqual({});
  });

  it("opens the file and dismisses from a task view", async () => {
    useTabs.getState().openTab({
      kind: "task",
      taskId: "task_a",
      projectSlug: "alpha",
      title: "Task A",
    });
    render(<QuickOpen />);

    await searchForFile("app");
    fireEvent.click(screen.getByRole("button", { name: /src\/app\.ts/i }));

    expect(useEditorTabs.getState().activePathByTask.task_a).toBe("src/app.ts");
    expect(useUi.getState().quickOpenOpen).toBe(false);
  });
});
