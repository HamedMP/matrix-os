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
  it("renders a practical quick-action console with shortcuts and status", () => {
    const output = renderToString(<HomeView snapshot={baseSnapshot} columns={100} noColor={false} />);

    expect(output).toContain("MATRIX OS");
    expect(output).toContain("Action console");
    expect(output).not.toContain("M   M   A   TTTTT");
    expect(output).toContain(".@@@@oo.o@@@.");
    expect(output).toContain("@@@@@@@@@@@@@@@");
    expect(output).toContain("> [n] New shell session");
    expect(output).toContain("[s] Open shell sessions");
    expect(output).toContain("[a] Setup coding agents");
    expect(output).toContain("[d] Run doctor");
    expect(output).toContain("[l] Log in");
    expect(output).toContain("q quit");
    expect(output).toContain("cloud");
    expect(output).toContain("2 sessions");
    expect(output).toContain("healthy · cloud · ok · 2 sessions");
  });

  it("keeps no-color home output understandable without ANSI escapes", () => {
    const output = renderToString(<HomeView snapshot={baseSnapshot} columns={100} noColor />);

    expect(output).toContain("MATRIX OS");
    expect(output).toContain("Quick actions");
    expect(output).toContain(".@@@@oo.o@@@.");
    expect(output).toContain("healthy");
    expect(output).not.toContain("\u001B[");
  });

  it("fills tall terminals as a fullscreen launcher", () => {
    const output = renderToString(<HomeView snapshot={baseSnapshot} columns={100} rows={40} noColor />);

    expect(output.split("\n").length).toBeGreaterThanOrEqual(40);
    expect(output).toContain("Quick actions");
  });

  it("keeps quick actions readable on normal-width terminals", () => {
    const output = renderToString(<HomeView snapshot={baseSnapshot} columns={80} noColor />);

    expect(output).toContain("New shell session");
    expect(output).toContain("Open shell sessions");
    expect(output).toContain("rabbit: .@@. @@@");
    expect(output).toContain("healthy · cloud · ok · 2 sessions");
  });

  it("hides large art and preserves critical prompt/status text in narrow terminals", () => {
    const output = renderToString(<HomeView snapshot={baseSnapshot} columns={60} noColor />);

    expect(output).toContain("MATRIX OS");
    expect(output).toContain("Quick actions");
    expect(output).toContain("cloud");
    expect(output).toContain("rabbit: .@@. @@@");
    expect(output).toContain("/ palette · q quit");
    expect(output).not.toContain(".@@@@oo.o@@@.");
  });
});
