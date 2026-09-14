// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TerminalLinkContextMenu } from "../../shell/src/components/terminal/TerminalLinkContextMenu.js";
import type { TerminalLinkEntry } from "../../shell/src/components/terminal/terminal-links.js";

const CLAUDE_LINK: TerminalLinkEntry = {
  url: `https://claude.com/cai/oauth/authorize?code=true&code_challenge=${"A".repeat(43)}`,
  hostname: "claude.com",
  displayPath: "/cai/oauth/authorize",
  kind: "claude-auth",
  providerLabel: "Claude Code",
};

describe("TerminalLinkContextMenu", () => {
  afterEach(() => vi.restoreAllMocks());

  it("renders provider-aware Open and Copy actions without visible OAuth parameters", () => {
    const onOpen = vi.fn();
    const onCopy = vi.fn();
    render(
      <TerminalLinkContextMenu
        menu={{ x: 100, y: 120, link: CLAUDE_LINK, selection: "selected output" }}
        onClose={vi.fn()}
        onOpen={onOpen}
        onCopy={onCopy}
        onCopySelection={vi.fn()}
        onSelectAll={vi.fn()}
      />,
    );

    expect(screen.getByRole("menu", { name: "Terminal actions" })).toBeTruthy();
    expect(screen.queryByText(/code_challenge=/)).toBeNull();
    const terminalCopy = screen.getByRole("menuitem", { name: "Copy" });
    expect(document.activeElement).toBe(terminalCopy);

    const open = screen.getByRole("menuitem", { name: "Sign in with Claude Code" });
    fireEvent.click(open);
    expect(onOpen).toHaveBeenCalledWith(CLAUDE_LINK);

    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Link" }));
    expect(onCopy).toHaveBeenCalledWith(CLAUDE_LINK);
  });

  it("closes on Escape and an outside pointer event", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <TerminalLinkContextMenu
        menu={{ x: 100, y: 120, link: CLAUDE_LINK, selection: "" }}
        onClose={onClose}
        onOpen={vi.fn()}
        onCopy={vi.fn()}
        onCopySelection={vi.fn()}
        onSelectAll={vi.fn()}
      />,
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(
      <TerminalLinkContextMenu
        menu={{ x: 100, y: 120, link: CLAUDE_LINK, selection: "" }}
        onClose={onClose}
        onOpen={vi.fn()}
        onCopy={vi.fn()}
        onCopySelection={vi.fn()}
        onSelectAll={vi.fn()}
      />,
    );
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("renders nothing without a resolved link", () => {
    const { container } = render(
      <TerminalLinkContextMenu
        menu={null}
        onClose={vi.fn()}
        onOpen={vi.fn()}
        onCopy={vi.fn()}
        onCopySelection={vi.fn()}
        onSelectAll={vi.fn()}
      />,
    );
    expect(container.lastElementChild).toBeNull();
  });

  it("offers general terminal Copy and Select All without a link", () => {
    const onCopySelection = vi.fn();
    const onSelectAll = vi.fn();
    const onClose = vi.fn();
    render(
      <TerminalLinkContextMenu
        menu={{
          x: 100,
          y: 120,
          link: null,
          selection: "first row\nλ second row 👩🏽‍💻",
        }}
        onClose={onClose}
        onOpen={vi.fn()}
        onCopy={vi.fn()}
        onCopySelection={onCopySelection}
        onSelectAll={onSelectAll}
      />,
    );

    expect(screen.getByRole("menu", { name: "Terminal actions" })).toBeTruthy();
    const copy = screen.getByRole("menuitem", { name: "Copy" }) as HTMLButtonElement;
    expect(copy.disabled).toBe(false);
    fireEvent.click(copy);
    fireEvent.click(screen.getByRole("menuitem", { name: "Select All" }));

    expect(onCopySelection).toHaveBeenCalledWith("first row\nλ second row 👩🏽‍💻");
    expect(onSelectAll).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("disables terminal Copy when the selection snapshot is empty", () => {
    render(
      <TerminalLinkContextMenu
        menu={{ x: 100, y: 120, link: null, selection: "" }}
        onClose={vi.fn()}
        onOpen={vi.fn()}
        onCopy={vi.fn()}
        onCopySelection={vi.fn()}
        onSelectAll={vi.fn()}
      />,
    );

    expect((screen.getByRole("menuitem", { name: "Copy" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
