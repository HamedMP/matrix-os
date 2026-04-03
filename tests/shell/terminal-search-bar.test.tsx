// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TerminalSearchBar } from "../../shell/src/components/terminal/TerminalSearchBar.js";

describe("TerminalSearchBar", () => {
  it("does not show results until the search addon reports them", () => {
    let onResults: ((result: { resultIndex: number; resultCount: number }) => void) | null = null;
    const searchAddon = {
      findNext: vi.fn(() => false),
      findPrevious: vi.fn(() => false),
      clearDecorations: vi.fn(),
      onDidChangeResults: vi.fn((callback: (result: { resultIndex: number; resultCount: number }) => void) => {
        onResults = callback;
        return { dispose: vi.fn() };
      }),
    };

    render(
      <TerminalSearchBar
        searchAddon={searchAddon}
        isOpen
        onClose={() => {}}
        theme={{ mode: "dark", colors: {} }}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("Search..."), {
      target: { value: "missing" },
    });

    expect(screen.queryByText("No results")).toBeNull();

    act(() => {
      onResults?.({ resultIndex: -1, resultCount: 0 });
    });

    expect(screen.getByText("No results")).toBeTruthy();
  });
});
