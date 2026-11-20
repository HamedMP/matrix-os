// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import QuickOpen from "../../desktop/src/renderer/src/features/files/QuickOpen";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useUi } from "../../desktop/src/renderer/src/stores/ui";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";
import { useDesktopEditor } from "../../desktop/src/renderer/src/features/editor/desktop-editor-store";

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
      composerOpen: false,
      paletteOpen: false,
      quickOpenOpen: true,
    });
    useTabs.setState(useTabs.getInitialState(), true);
    useDesktopEditor.setState(useDesktopEditor.getInitialState(), true);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("opens a result in the Editor app and dismisses", async () => {
    render(<QuickOpen />);

    await searchForFile("app");
    fireEvent.click(screen.getByRole("button", { name: /src\/app\.ts/i }));

    expect(useDesktopEditor.getState().activePath).toBe("src/app.ts");
    expect(useTabs.getState().tabs.some((tab) => tab.kind === "editor")).toBe(true);
    expect(useUi.getState().quickOpenOpen).toBe(false);
  });

  it("keeps the dialog open with feedback when a result cannot be opened", async () => {
    useConnection.setState({ api: { get: vi.fn().mockResolvedValue({ results: ["../outside.ts"] }) } as never });
    render(<QuickOpen />);

    await searchForFile("outside");
    fireEvent.click(screen.getByRole("button", { name: /outside\.ts/i }));

    expect(screen.getByRole("status").textContent).toContain("outside Matrix home");
    expect(useUi.getState().quickOpenOpen).toBe(true);
    expect(useDesktopEditor.getState().paths).toEqual([]);
  });
});
