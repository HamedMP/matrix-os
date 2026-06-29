// @vitest-environment jsdom
import React from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function installMocks(agentConnected: boolean, githubAuthed: boolean) {
  vi.doMock("@clerk/nextjs", () => ({ useUser: () => ({ user: { publicMetadata: {} } }) }));
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url: any) => {
    const u = String(url);
    if (u.includes("/api/agents/credentials/status")) return new Response(JSON.stringify({ agents: [{ id: "claude", available: agentConnected }] }), { status: 200 });
    if (u.includes("/api/github/status")) return new Response(JSON.stringify({ installed: true, authenticated: githubAuthed, user: githubAuthed ? "hamedmp" : null }), { status: 200 });
    return new Response("{}", { status: 200 });
  });
}

async function load() { vi.resetModules(); return await import("../../shell/src/components/onboarding/SetupChecklist.js"); }

describe("SetupChecklist", () => {
  beforeEach(() => { vi.resetModules(); vi.restoreAllMocks(); });
  afterEach(() => vi.restoreAllMocks());

  it("renders the three steps and a 'Set up your workspace' header", async () => {
    installMocks(false, false);
    const { SetupChecklist } = await load();
    render(<SetupChecklist onOpenTerminal={() => {}} />);
    expect(screen.getByText("Set up your workspace")).toBeTruthy();
    expect(screen.getByText(/Connect a coding agent/i)).toBeTruthy();
    expect(screen.getByText(/Connect GitHub/i)).toBeTruthy();
    expect(screen.getByText(/Clone or import a repo/i)).toBeTruthy();
  });
});
