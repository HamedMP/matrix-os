// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "../../shell/src/components/CommandPalette";
import { useCommandStore } from "../../shell/src/stores/commands";

describe("web CommandPalette design", () => {
  beforeEach(() => {
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    useCommandStore.setState({ commands: new Map() });
    useCommandStore.getState().register([
      { id: "app:notes", label: "Notes", group: "Apps", execute: vi.fn() },
      { id: "action:new-chat", label: "New Chat", group: "Actions", shortcut: "Cmd+N", execute: vi.fn() },
      { id: "action:open-settings", label: "Open Settings", group: "Actions", shortcut: "Cmd+,", keywords: ["preferences"], execute: vi.fn() },
    ]);
  });

  it("focuses its large search field and filters through functional categories", async () => {
    render(<CommandPalette open onOpenChange={vi.fn()} />);

    const input = screen.getByPlaceholderText("Type a command or search…");
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(input.className).toContain("focus-visible:shadow-none");
    expect(screen.getByText("⌘K")).toBeTruthy();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "All",
      "Apps",
      "Actions",
      "Settings",
    ]);

    fireEvent.click(screen.getByRole("tab", { name: "Apps" }));
    expect(screen.getByText("Notes").closest("[cmdk-item]")?.hasAttribute("data-instant-list-hover")).toBe(true);
    expect(screen.queryByText("New Chat")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Settings" }));
    expect(screen.getByText("Open Settings")).toBeTruthy();
    expect(screen.queryByText("Notes")).toBeNull();
  });
});
