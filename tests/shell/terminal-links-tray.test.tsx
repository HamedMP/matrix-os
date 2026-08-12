// @vitest-environment jsdom

import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TerminalLinksTray } from "../../shell/src/components/terminal/TerminalLinksTray.js";
import type {
  TerminalLinkEntry,
  TerminalLinksState,
} from "../../shell/src/components/terminal/terminal-links.js";

const CLAUDE_LINK: TerminalLinkEntry = {
  url: `https://claude.com/cai/oauth/authorize?code=true&code_challenge=${"A".repeat(43)}`,
  hostname: "claude.com",
  displayPath: "/cai/oauth/authorize",
  kind: "claude-auth",
  providerLabel: "Claude Code",
};

const WEB_LINKS: TerminalLinkEntry[] = [
  {
    url: "https://github.com/HamedMP/matrix-os",
    hostname: "github.com",
    displayPath: "/HamedMP/matrix-os",
    kind: "web",
  },
  {
    url: "http://localhost:3000/status",
    hostname: "localhost:3000",
    displayPath: "/status",
    kind: "web",
  },
];

function state(
  presentation: TerminalLinksState["presentation"],
  entries: TerminalLinkEntry[] = [CLAUDE_LINK, ...WEB_LINKS],
): TerminalLinksState {
  return {
    entries,
    presentation,
    activeUrl: entries[0]?.url ?? null,
  };
}

function renderTray(presentation: TerminalLinksState["presentation"] = "expanded") {
  const props = {
    state: state(presentation),
    onCollapse: vi.fn(),
    onDismiss: vi.fn(),
    onOpen: vi.fn(),
    onCopy: vi.fn(),
  };
  render(<TerminalLinksTray {...props} />);
  return props;
}

describe("TerminalLinksTray", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders a compact provider action without exposing OAuth parameters", () => {
    const props = renderTray();

    expect(screen.getByText("Claude Code sign-in")).toBeTruthy();
    expect(screen.getByText("claude.com/cai/oauth/authorize")).toBeTruthy();
    expect(screen.queryByText(/code_challenge=/)).toBeNull();
    expect(screen.getByRole("status").getAttribute("style")).toContain("420px");

    fireEvent.click(screen.getByRole("button", { name: "Sign in with Claude Code" }));
    expect(props.onOpen).toHaveBeenCalledWith(CLAUDE_LINK);
    expect(props.onCollapse).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    expect(props.onCopy).toHaveBeenCalledWith(CLAUDE_LINK);
  });

  it("automatically collapses the expanded tray after eight seconds", () => {
    vi.useFakeTimers();
    const props = renderTray();

    act(() => vi.advanceTimersByTime(7_999));
    expect(props.onCollapse).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(props.onCollapse).toHaveBeenCalledTimes(1);
  });

  it("opens a newest-first list with per-link actions and one shared warning", () => {
    const props = renderTray("collapsed");
    const trigger = screen.getByRole("button", { name: "Show 3 terminal links" });

    fireEvent.click(trigger);

    expect(screen.getByRole("dialog", { name: "Terminal links" })).toBeTruthy();
    expect(screen.getAllByText("Links come from terminal output. Open only what you trust."))
      .toHaveLength(1);
    expect(screen.getAllByTestId("terminal-link-row").map((row) => row.textContent)).toEqual([
      expect.stringContaining("Claude Code"),
      expect.stringContaining("github.com"),
      expect.stringContaining("localhost:3000"),
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Copy https://github.com/HamedMP/matrix-os" }));
    expect(props.onCopy).toHaveBeenCalledWith(WEB_LINKS[0]);
    expect(props.onCollapse).toHaveBeenCalledTimes(1);
  });

  it("closes the link list with Escape and restores focus to its trigger", () => {
    renderTray("collapsed");
    const trigger = screen.getByRole("button", { name: "Show 3 terminal links" });
    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "Terminal links" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("dismisses either tray form and renders nothing while hidden", () => {
    const props = renderTray("collapsed");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss terminal links" }));
    expect(props.onDismiss).toHaveBeenCalledTimes(1);

    const { container } = render(
      <TerminalLinksTray
        state={state("hidden")}
        onCollapse={vi.fn()}
        onDismiss={vi.fn()}
        onOpen={vi.fn()}
        onCopy={vi.fn()}
      />,
    );
    expect(container.lastElementChild).toBeNull();
  });
});
