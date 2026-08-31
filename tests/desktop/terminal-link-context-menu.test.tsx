// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import TerminalLinkContextMenu from "@desktop/renderer/src/features/terminal/TerminalLinkContextMenu";

const LINK = {
  url: "https://example.org/final-check",
  hostname: "example.org",
  displayPath: "/final-check",
  kind: "web" as const,
};

describe("Desktop TerminalLinkContextMenu", () => {
  it("offers terminal and link actions without showing the full URL", () => {
    const onOpen = vi.fn();
    const onCopy = vi.fn();
    const onCopySelection = vi.fn();
    const onSelectAll = vi.fn();
    render(
      <TerminalLinkContextMenu
        menu={{ x: 120, y: 140, link: LINK, selection: "selected output", runtimeScope: "runtime-a" }}
        onClose={vi.fn()}
        onOpen={onOpen}
        onCopy={onCopy}
        onCopySelection={onCopySelection}
        onSelectAll={onSelectAll}
      />,
    );

    expect(screen.getByRole("menu", { name: "Terminal actions" })).toBeTruthy();
    expect(screen.queryByText(LINK.url)).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Select All" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open Link" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Link" }));

    expect(onCopySelection).toHaveBeenCalledWith("selected output");
    expect(onSelectAll).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledWith(LINK, "runtime-a");
    expect(onCopy).toHaveBeenCalledWith(LINK);
  });

  it("uses a provider-aware action label", () => {
    render(
      <TerminalLinkContextMenu
        menu={{
          x: 120,
          y: 140,
          selection: "",
          runtimeScope: "runtime-a",
          link: {
            url: "https://auth.openai.com/codex/device",
            hostname: "auth.openai.com",
            displayPath: "/codex/device",
            kind: "codex-auth",
            providerLabel: "Codex",
          },
        }}
        onClose={vi.fn()}
        onOpen={vi.fn()}
        onCopy={vi.fn()}
        onCopySelection={vi.fn()}
        onSelectAll={vi.fn()}
      />,
    );

    expect(screen.getByRole("menuitem", { name: "Sign in with Codex" })).toBeTruthy();
  });

  it("closes with Escape", () => {
    const onClose = vi.fn();
    render(
      <TerminalLinkContextMenu
        menu={{ x: 120, y: 140, link: LINK, selection: "", runtimeScope: "runtime-a" }}
        onClose={onClose}
        onOpen={vi.fn()}
        onCopy={vi.fn()}
        onCopySelection={vi.fn()}
        onSelectAll={vi.fn()}
      />,
    );

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).toHaveBeenCalledOnce();
  });
});
