// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React, { useMemo } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopTopBarActions } from "../../packages/ui/src/desktop-top-bar.js";
import { GettingStartedMenuSummary, GettingStartedPill } from "../../packages/ui/src/getting-started-pill.js";
import { gettingStartedNextStep, shouldShowGettingStartedPill } from "../../packages/ui/src/getting-started-progress.js";
import {
  GettingStartedVisibilityProvider,
  useGettingStartedProgress,
  usePublishGettingStartedProgress,
} from "../../packages/ui/src/getting-started-visibility.js";

afterEach(cleanup);

describe("Getting started pill", () => {
  it("shows compact setup progress while keeping the full accessible label", () => {
    render(<GettingStartedPill completed={4} total={5} />);
    const pill = screen.getByRole("button", { name: "Getting started — 4 of 5" });
    expect(pill.textContent).toBe("Setup 4/5");
    expect(pill.querySelector("svg circle[data-progress]")?.getAttribute("stroke-dasharray")).toBeTruthy();
  });

  it("disappears once setup is complete unless the checklist is still open", () => {
    expect(shouldShowGettingStartedPill({ loaded: false, completed: 0, total: 5, open: false })).toBe(false);
    expect(shouldShowGettingStartedPill({ loaded: true, completed: 4, total: 5, open: false })).toBe(true);
    expect(shouldShowGettingStartedPill({ loaded: true, completed: 5, total: 5, open: false })).toBe(false);
    // The open checklist keeps its anchor until the owner closes it.
    expect(shouldShowGettingStartedPill({ loaded: true, completed: 5, total: 5, open: true })).toBe(true);
  });

  it("names the first actionable step as next", () => {
    expect(gettingStartedNextStep([
      { label: "Connect GitHub", status: "complete" },
      { label: "Log in to Claude", status: "unavailable" },
      { label: "Add billing", status: "incomplete" },
    ])).toBe("Add billing");
    expect(gettingStartedNextStep([{ label: "Log in to Claude", status: "unavailable" }])).toBe("Log in to Claude");
    expect(gettingStartedNextStep([{ label: "Done", status: "complete" }])).toBeNull();
  });

  it("renders the account menu summary with progress and next step", () => {
    render(<GettingStartedMenuSummary completed={2} total={5} next="Add billing" />);
    expect(screen.getByText("Getting started")).toBeTruthy();
    expect(screen.getByText("2 of 5")).toBeTruthy();
    expect(screen.getByText("Next: Add billing")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("2");
  });
});

function Publisher({ completed, open }: { completed: number; open(): void }) {
  usePublishGettingStartedProgress(useMemo(() => ({ completed, total: 5, next: "Add billing", open }), [completed, open]));
  return null;
}
function Reader() {
  const progress = useGettingStartedProgress();
  return progress ? <button type="button" onClick={progress.open}>{`${progress.completed}/${progress.total} ${progress.next}`}</button> : <p>none</p>;
}

describe("Getting started progress sharing", () => {
  it("lets the account menu read and open the checklist owned by the top bar", () => {
    const open = vi.fn();
    const view = render(<GettingStartedVisibilityProvider scope="a"><Publisher completed={1} open={open} /><Reader /></GettingStartedVisibilityProvider>);
    fireEvent.click(screen.getByRole("button", { name: "1/5 Add billing" }));
    expect(open).toHaveBeenCalledOnce();
    view.rerender(<GettingStartedVisibilityProvider scope="a"><Publisher completed={3} open={open} /><Reader /></GettingStartedVisibilityProvider>);
    expect(screen.getByRole("button", { name: "3/5 Add billing" })).toBeTruthy();
    view.rerender(<GettingStartedVisibilityProvider scope="a"><Reader /></GettingStartedVisibilityProvider>);
    expect(screen.getByText("none")).toBeTruthy();
  });

  it("is safe without a provider", () => {
    render(<Reader />);
    expect(screen.getByText("none")).toBeTruthy();
  });
});

describe("Desktop top bar order", () => {
  it("leads with setup, has no Help button, and keeps Support chat", () => {
    const support = vi.fn();
    render(<DesktopTopBarActions onSearch={vi.fn()} onSupport={support} onTerminal={vi.fn()}
      setup={<button type="button">Setup</button>} inbox={<button type="button">Inbox</button>}
      computer={<button type="button">Computer</button>} update={<button type="button">Update</button>} account={<button type="button">Avatar</button>} />);
    expect(screen.getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent))
      .toEqual(["Setup", "Search", "Terminal window", "Inbox", "Support", "Computer", "Update", "Avatar"]);
    expect(screen.queryByRole("button", { name: "Help" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Support" }));
    expect(support).toHaveBeenCalledOnce();
  });
});
