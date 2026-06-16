// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AppLauncher from "../../desktop/src/renderer/src/features/embeds/AppLauncher";
import { useApps } from "../../desktop/src/renderer/src/stores/apps";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";

describe("AppLauncher", () => {
  beforeEach(() => {
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      platformHost: "https://platform.test",
      runtimeSlot: "primary",
      api: null,
    });
    useApps.setState({
      apps: [
        { slug: "alpha", name: "Alpha" },
        { slug: "beta", name: "Beta" },
        { slug: "bravo", name: "Bravo" },
      ],
      loaded: true,
      loading: false,
      error: null,
    });
    useTabs.setState({ tabs: [], activeTabId: null });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("falls back to slug names and skips invalid app rows", async () => {
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      platformHost: "https://platform.test",
      runtimeSlot: "primary",
      api: {
        get: vi.fn().mockResolvedValue({
          apps: [
            { slug: "notes", name: 42 },
            { slug: "chat", name: "Chat" },
            { slug: "", name: "Blank" },
            { name: "Missing slug" },
          ],
        }),
      } as never,
    });
    useApps.setState({ apps: [], loaded: false, loading: false, error: null });

    render(<AppLauncher />);

    expect(await screen.findByRole("button", { name: /notes/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /chat/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /blank/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /missing slug/i })).toBeNull();
  });

  it("resets the active app when the search query changes", async () => {
    render(<AppLauncher />);
    const search = screen.getByLabelText("Search apps");

    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.change(search, { target: { value: "b" } });
    fireEvent.keyDown(search, { key: "Enter" });

    await waitFor(() => {
      expect(useTabs.getState().tabs[0]).toMatchObject({
        kind: "app",
        slug: "beta",
        title: "Beta",
      });
    });
  });

  it("does not show a no-match state before the app catalog loads", () => {
    useApps.setState({
      apps: [],
      loaded: false,
      loading: true,
      error: null,
    });

    render(<AppLauncher />);

    expect(screen.getByText("Loading apps")).toBeTruthy();
    expect(screen.queryByText(/No apps match/i)).toBeNull();
  });
});
