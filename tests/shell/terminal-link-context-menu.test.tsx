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
        menu={{ x: 100, y: 120, link: CLAUDE_LINK }}
        onClose={vi.fn()}
        onOpen={onOpen}
        onCopy={onCopy}
      />,
    );

    expect(screen.getByRole("menu", { name: "Link actions" })).toBeTruthy();
    expect(screen.queryByText(/code_challenge=/)).toBeNull();
    const open = screen.getByRole("menuitem", { name: "Sign in with Claude Code" });
    expect(document.activeElement).toBe(open);

    fireEvent.click(open);
    expect(onOpen).toHaveBeenCalledWith(CLAUDE_LINK);

    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Link" }));
    expect(onCopy).toHaveBeenCalledWith(CLAUDE_LINK);
  });

  it("closes on Escape and an outside pointer event", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <TerminalLinkContextMenu
        menu={{ x: 100, y: 120, link: CLAUDE_LINK }}
        onClose={onClose}
        onOpen={vi.fn()}
        onCopy={vi.fn()}
      />,
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(
      <TerminalLinkContextMenu
        menu={{ x: 100, y: 120, link: CLAUDE_LINK }}
        onClose={onClose}
        onOpen={vi.fn()}
        onCopy={vi.fn()}
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
      />,
    );
    expect(container.lastElementChild).toBeNull();
  });
});
