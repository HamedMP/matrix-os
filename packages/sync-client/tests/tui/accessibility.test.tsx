import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { HomeView } from "../../src/cli/tui/views/HomeView.js";
import { CommandPalette } from "../../src/cli/tui/views/CommandPalette.js";
import { DEFAULT_TUI_ACTIONS } from "../../src/cli/tui/actions.js";
import { searchTuiActions } from "../../src/cli/tui/palette.js";
import type { TuiStatusSnapshot } from "../../src/cli/tui/status.js";

const snapshot: TuiStatusSnapshot = {
  overall: "degraded",
  profile: { name: "cloud", gatewayUrl: "https://app.matrix-os.com", platformUrl: "https://app.matrix-os.com", state: "healthy" },
  auth: { state: "authenticated", handle: "nim" },
  gateway: { state: "degraded", label: "gateway degraded" },
  daemon: { state: "healthy", label: "running" },
  sync: { state: "healthy", label: "sync ready" },
  sessions: { state: "healthy", count: 1 },
  blockingActions: [],
  refreshedAt: "2026-05-28T12:00:00.000Z",
};

describe("TUI accessibility rendering", () => {
  it("keeps no-color home and palette readable without escape codes", () => {
    const home = renderToString(<HomeView snapshot={snapshot} columns={80} noColor />);
    const results = searchTuiActions(DEFAULT_TUI_ACTIONS, "review", 8);
    const palette = renderToString(<CommandPalette results={results} query="review" noColor />);

    expect(home).toContain("degraded");
    expect(home).toContain("gateway degraded");
    expect(palette).toContain("MATRIX COMMANDS");
    expect(`${home}${palette}`).not.toContain("\u001B[");
  });
});
