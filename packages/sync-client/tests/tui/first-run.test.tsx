import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { FirstRunView } from "../../src/cli/tui/views/FirstRunView.js";
import type { TuiStatusSnapshot } from "../../src/cli/tui/status.js";

function snapshot(overrides: Partial<TuiStatusSnapshot> = {}): TuiStatusSnapshot {
  return {
    overall: "unauthenticated",
    profile: { name: "cloud", gatewayUrl: "https://app.matrix-os.com", platformUrl: "https://app.matrix-os.com", state: "healthy" },
    auth: { state: "unauthenticated" },
    gateway: { state: "unknown", label: "gateway unknown" },
    daemon: { state: "offline", label: "stopped" },
    sync: { state: "unknown", label: "sync unknown" },
    sessions: { state: "unknown", count: 0 },
    blockingActions: ["login"],
    refreshedAt: "2026-05-28T12:00:00.000Z",
    ...overrides,
  };
}

describe("first-run view", () => {
  it("prioritizes login for logged-out users", () => {
    const output = renderToString(<FirstRunView snapshot={snapshot()} noColor />);

    expect(output).toContain("Welcome to Matrix OS");
    expect(output).toContain("Log in");
    expect(output).toContain("cloud");
  });

  it("offers sync setup once authenticated and sync is missing", () => {
    const output = renderToString(<FirstRunView snapshot={snapshot({ overall: "healthy", auth: { state: "authenticated", handle: "nim" }, blockingActions: [] })} noColor />);

    expect(output).toContain("Start sync");
    expect(output).toContain("~/matrixos");
  });
});
