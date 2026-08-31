// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PaneGrid } from "../../shell/src/components/terminal/PaneGrid.js";

vi.mock("../../shell/src/components/terminal/TerminalPane.js", () => ({
  TerminalPane: () => <div>Live terminal</div>,
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
});
