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
  it("offers Open and Copy for the resolved URL without showing the full URL", () => {
    const onOpen = vi.fn();
    const onCopy = vi.fn();
    render(
      <TerminalLinkContextMenu
        menu={{ x: 120, y: 140, link: LINK }}
        onClose={vi.fn()}
        onOpen={onOpen}
        onCopy={onCopy}
      />,
    );

    expect(screen.getByRole("menu", { name: "Link actions" })).toBeTruthy();
    expect(screen.queryByText(LINK.url)).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Open Link" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Link" }));

    expect(onOpen).toHaveBeenCalledWith(LINK);
    expect(onCopy).toHaveBeenCalledWith(LINK);
  });

  it("uses a provider-aware action label", () => {
    render(
      <TerminalLinkContextMenu
        menu={{
          x: 120,
          y: 140,
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
      />,
    );

    expect(screen.getByRole("menuitem", { name: "Sign in with Codex" })).toBeTruthy();
  });

  it("closes with Escape", () => {
    const onClose = vi.fn();
    render(
      <TerminalLinkContextMenu
        menu={{ x: 120, y: 140, link: LINK }}
        onClose={onClose}
        onOpen={vi.fn()}
        onCopy={vi.fn()}
      />,
    );

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).toHaveBeenCalledOnce();
  });
});
