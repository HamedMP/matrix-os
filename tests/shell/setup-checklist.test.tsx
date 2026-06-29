// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  beforeEach(() => { vi.resetModules(); vi.restoreAllMocks(); window.localStorage.clear(); });
  afterEach(() => { vi.restoreAllMocks(); window.localStorage.clear(); });

  it("renders the three steps and a 'Set up your workspace' header", async () => {
    installMocks(false, false);
    const { SetupChecklist } = await load();
    render(<SetupChecklist onOpenTerminal={() => {}} />);
    expect(screen.getByText("Set up your workspace")).toBeTruthy();
    expect(screen.getByText("Connect a coding agent")).toBeTruthy();
    expect(screen.getByText(/Connect GitHub/i)).toBeTruthy();
    expect(screen.getByText(/Clone or import a repo/i)).toBeTruthy();
  });

  it("persists dismissal across remounts via localStorage", async () => {
    installMocks(false, false);
    const { SetupChecklist } = await load();

    const first = render(<SetupChecklist onOpenTerminal={() => {}} />);
    expect(await screen.findByText("Set up your workspace")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(screen.queryByText("Set up your workspace")).toBeNull();
    expect(window.localStorage.getItem("matrix:setup-checklist-dismissed")).toBe("1");
    first.unmount();

    // A fresh mount (new tab or reload) must remain dismissed, not reappear.
    render(<SetupChecklist onOpenTerminal={() => {}} />);
    await waitFor(() => expect(screen.queryByText("Set up your workspace")).toBeNull());
  });
});
