// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PaneGrid } from "../../shell/src/components/terminal/PaneGrid.js";

const terminalPaneProps = vi.hoisted(() => [] as Array<{ onSessionEnded?: (sessionId: string) => void }>);

vi.mock("../../shell/src/components/terminal/TerminalPane.js", () => ({
  TerminalPane: (props: { onSessionEnded?: (sessionId: string) => void }) => {
    terminalPaneProps.push(props);
    return <div>Live terminal</div>;
  },
}));

const theme = {
  name: "matrix-dark",
  mode: "dark" as const,
  colors: { background: "#000", foreground: "#fff", primary: "#39ff6a" },
  fonts: { mono: "monospace", sans: "sans-serif" },
  radius: "0.75rem",
};

describe("PaneGrid missing session recovery", () => {
  it("renders a recoverable placeholder instead of attaching a missing runtime", async () => {
    const onRecoverSession = vi.fn(async () => true);
    render(<PaneGrid
      paneTree={{ type: "pane", id: "pane-one", cwd: "projects/demo", sessionId: "bench" }}
      theme={theme}
      unavailableSessionIds={["bench"]}
      onRecoverSession={onRecoverSession}
    />);

    expect(screen.queryByText("Live terminal")).toBeNull();
    expect(screen.getByText("Session is unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Recover bench" }));

    await vi.waitFor(() => {
      expect(onRecoverSession).toHaveBeenCalledWith("bench", "projects/demo");
    });
  });

  it("shows a bounded retry message when explicit recovery fails", async () => {
    render(<PaneGrid
      paneTree={{ type: "pane", id: "pane-one", cwd: "projects", sessionId: "bench" }}
      theme={theme}
      unavailableSessionIds={["bench"]}
      onRecoverSession={vi.fn(async () => false)}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Recover bench" }));

    expect(await screen.findByText("Recovery failed. Try again.")).toBeTruthy();
  });

  // A Herdr terminal belongs to herdr-core and cannot be recreated, so an ended one
  // must not offer a Recover action that can only fail (Greptile follow-up on #3530).
  it("shows an ended Herdr session without a Recover action", () => {
    const herdrRef = `tws_00000000000000000000006865726472:tt_${"8".repeat(32)}`;
    const onRecoverSession = vi.fn(async () => false);
    render(<PaneGrid
      paneTree={{ type: "pane", id: "pane-one", cwd: "~", sessionId: herdrRef }}
      theme={theme}
      unavailableSessionIds={[herdrRef]}
      onRecoverSession={onRecoverSession}
    />);

    expect(screen.queryByText("Live terminal")).toBeNull();
    expect(screen.getByText("This Herdr session has ended")).toBeTruthy();
    expect(screen.queryByText("Session is unavailable")).toBeNull();
    expect(screen.queryByRole("button", { name: /Recover/ })).toBeNull();
    expect(onRecoverSession).not.toHaveBeenCalled();
  });

  it("tells the app when a live pane's terminal has ended", () => {
    const onSessionEnded = vi.fn();
    render(<PaneGrid
      paneTree={{ type: "pane", id: "pane-one", cwd: "~", sessionId: "bench" }}
      theme={theme}
      onSessionEnded={onSessionEnded}
    />);
    terminalPaneProps.at(-1)?.onSessionEnded?.("bench");
    expect(onSessionEnded).toHaveBeenCalledWith("bench");
  });
});
