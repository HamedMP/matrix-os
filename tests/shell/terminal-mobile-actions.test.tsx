// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaneNode } from "../../shell/src/stores/terminal-store.js";
import { TERMINAL_INPUT_EVENT, type TerminalInputEventDetail } from "../../shell/src/components/terminal/terminal-input-event.js";

vi.mock("../../shell/src/components/terminal/PaneGrid.js", () => ({
  PaneGrid: ({ paneTree, onSessionAttached }: { paneTree: PaneNode; onSessionAttached?: (paneId: string, sessionId: string) => void }) => {
    const paneId = paneTree.type === "pane" ? paneTree.id : "pane-1";
    React.useEffect(() => {
      onSessionAttached?.(paneId, "main");
    }, [onSessionAttached, paneId]);
    return <div data-testid="pane-grid" data-pane-id={paneId} />;
  },
}));

vi.mock("../../shell/src/components/terminal/TerminalKeyBar.js", () => ({
  TerminalKeyBar: () => <div data-testid="terminal-key-bar" />,
}));

vi.mock("@/hooks/useTheme", () => ({
  useTheme: () => ({
    mode: "dark",
    colors: { background: "#101010", foreground: "#eeeeee", primary: "#d88944" },
    fonts: {},
  }),
}));

vi.mock("@/stores/terminal-settings", () => {
  const state = {
    appThemeId: "matrix-dark",
    themeId: "system",
    fontSize: 13,
    fontFamily: "JetBrains Mono",
    ligatures: true,
    cursorStyle: "block",
    smoothScroll: true,
    cursorBlink: true,
    setAppThemeId: () => {},
    setThemeId: () => {},
    setFontSize: () => {},
    setFontFamily: () => {},
    setLigatures: () => {},
    setCursorStyle: () => {},
    setSmoothScroll: () => {},
    setCursorBlink: () => {},
  };

  return {
    TERMINAL_FONT_FAMILIES: ["MesloLGS NF", "Berkeley Mono", "JetBrains Mono", "Fira Code"],
    DEFAULT_TERMINAL_THEME_ID: "dark",
    DEFAULT_TERMINAL_APP_THEME_ID: "matrix-dark",
    useTerminalSettings: (selector: (value: typeof state) => unknown) => selector(state),
  };
});

import { TerminalApp } from "../../shell/src/components/terminal/TerminalApp.js";

describe("TerminalApp mobile actions", () => {
  beforeEach(() => {
    class ResizeObserverMock {
      observe = vi.fn();
      disconnect = vi.fn();
    }

    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith("/api/terminal/layout") && init?.method !== "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ tabs: [] }) });
      }
      if (url.endsWith("/api/terminal/sessions")) {
        return Promise.resolve({ ok: true, status: 201, json: async () => ({}) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));
  });

  it("shows mobile terminal actions above the accessory keybar", async () => {
    render(<TerminalApp mobile />);

    await waitFor(() => expect(screen.getByTestId("terminal-mobile-actions")).toBeTruthy());

    for (const name of ["Shell", "Pane", "Tab", "Cmd", "Paste", "Search"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
  });

  it("dispatches paste and search actions to the focused pane", async () => {
    const events: TerminalInputEventDetail[] = [];
    const listener = ((event: CustomEvent<TerminalInputEventDetail>) => {
      events.push(event.detail);
    }) as EventListener;
    window.addEventListener(TERMINAL_INPUT_EVENT, listener);

    render(<TerminalApp mobile />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Paste" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Paste" }));
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    expect(events).toEqual([
      expect.objectContaining({ action: "paste" }),
      expect.objectContaining({ action: "search" }),
    ]);
    window.removeEventListener(TERMINAL_INPUT_EVENT, listener);
  });
});
