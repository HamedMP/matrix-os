import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { HomeView } from "../../src/cli/tui/views/HomeView.js";
import type { TuiStatusSnapshot } from "../../src/cli/tui/status.js";

const baseSnapshot: TuiStatusSnapshot = {
  overall: "healthy",
  profile: { name: "cloud", gatewayUrl: "https://app.matrix-os.com", platformUrl: "https://app.matrix-os.com", state: "healthy" },
  auth: { state: "authenticated", handle: "nim" },
  gateway: { state: "healthy", label: "ok" },
  daemon: { state: "healthy", label: "running" },
  sync: { state: "unknown", label: "sync unknown" },
  sessions: { state: "healthy", count: 2 },
  blockingActions: [],
  refreshedAt: "2026-05-28T12:00:00.000Z",
};

describe("HomeView", () => {
  it("renders prompt-first Matrix OS home with compact status", () => {
    const output = renderToString(<HomeView snapshot={baseSnapshot} columns={100} noColor={false} />);

    expect(output).toContain("Matrix OS");
    expect(output).toContain("Ask Hermes");
    expect(output).toContain("cloud");
    expect(output).toContain("2 sessions");
    expect(output).toContain("/ commands");
  });

  it("keeps no-color output understandable", () => {
    const output = renderToString(<HomeView snapshot={baseSnapshot} columns={100} noColor />);

    expect(output).toContain("healthy");
    expect(output).not.toContain("\u001B[");
  });

  it("hides mascot and preserves critical text in narrow terminals", () => {
    const output = renderToString(<HomeView snapshot={baseSnapshot} columns={60} noColor />);

    expect(output).toContain("Ask Hermes");
    expect(output).toContain("cloud");
    expect(output).not.toContain("rabbit");
  });
});
