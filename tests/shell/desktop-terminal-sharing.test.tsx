// @vitest-environment jsdom

import React from "react";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaneNode } from "../../shell/src/stores/terminal-store";
import type { ShellSessionSummary } from "../../shell/src/components/terminal/terminal-session-state";

// The project control resolves a runtime and talks to the platform; the sidebar tests
// only care that Web Desktop mounts it, and for which project.
vi.mock("@/components/projects/ProjectSharing", () => ({
  ProjectSharing: ({ projectId }: { projectId: string }) => <span data-testid="project-share">{projectId}</span>,
}));
vi.mock("../../shell/src/components/terminal/TerminalThemePicker", () => ({
  ThemePickerButton: () => null,
}));
// A signed-in member inside an organization, on a runtime with collaboration on: the
// exact conditions under which a terminal share control used to appear.
vi.mock("@clerk/nextjs", () => ({ useOrganization: () => ({ organization: { id: "org_matrix_team" } }) }));

import { DesktopTerminalSidebar } from "../../shell/src/components/terminal/DesktopTerminalSidebar";
import { DesktopTerminalSessionHeader } from "../../shell/src/components/terminal/DesktopTerminalWorkspace";
import { TerminalEmbeddedToolbar, TerminalWorkspaceChrome } from "../../shell/src/components/terminal/TerminalChrome";
import { TerminalAppContext, type TerminalAppContextType } from "../../shell/src/components/terminal/TerminalAppContext";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    runtime: { handle: "owner", runtimeSlot: "primary", machineId: "10000000-0000-4000-8000-000000000001" },
    capabilities: { collaboration: true },
  }), { headers: { "content-type": "application/json" } })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

function session(name: string, project?: string): ShellSessionSummary {
  return { name, workspaceId: project ?? "main", tabId: name, revision: 1, workspaceRevision: 1, ...(project ? { project } : {}) };
}

function renderSidebar(sessions: ShellSessionSummary[]) {
  return render(
    <DesktopTerminalSidebar
      sessions={sessions}
      selectedName={null}
      creating={false}
      onCreate={vi.fn()}
      onOpen={vi.fn()}
      onDelete={vi.fn()}
    />,
  );
}

describe("Web Desktop terminal sidebar project sharing (#1798)", () => {
  it("offers the project share control on each named project, which Web Desktop could not reach", () => {
    renderSidebar([session("api", "billing"), session("web", "billing"), session("scratch")]);

    const billing = screen.getByRole("list", { name: "billing sessions" });
    expect(within(billing).getByRole("button", { name: "Open api" })).toBeTruthy();
    expect(within(billing).getByRole("button", { name: "Open web" })).toBeTruthy();
    expect(screen.getAllByTestId("project-share").map((node) => node.textContent)).toEqual(["billing"]);
  });

  it("never offers a share control for the unscoped main workspace", () => {
    renderSidebar([session("api", "billing"), session("scratch")]);

    expect(screen.getByRole("list", { name: "Main sessions" })).toBeTruthy();
    expect(screen.getAllByTestId("project-share")).toHaveLength(1);
  });

  it("keeps the flat list unchanged for a member who only uses main", () => {
    renderSidebar([session("scratch"), session("notes")]);

    expect(screen.queryByRole("list", { name: "Main sessions" })).toBeNull();
    expect(screen.queryByTestId("project-share")).toBeNull();
    expect(screen.getByRole("button", { name: "Open scratch" })).toBeTruthy();
  });
});

describe("terminal chrome offers no single-terminal share: projects are the only live-shareable resource", () => {
  it("keeps the Web Desktop session header to its title and status", async () => {
    render(<DesktopTerminalSessionHeader title="api" />);
    await settle();

    const header = screen.getByTestId("terminal-desktop-session-header");
    expect(within(header).getByRole("heading", { name: "api" })).toBeTruthy();
    expect(within(header).getByText("Active")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Share\b/i })).toBeNull();
  });

  const paneTree: PaneNode = { type: "pane", id: "pane-api", cwd: "/", sessionId: "session-api" };
  function renderChrome(chrome: React.ReactNode, mobile: boolean) {
    const ctx = {
      tabs: [{ id: "tab-api", label: "api", paneTree }],
      activeTabId: "tab-api",
      focusedPaneId: "pane-api",
      mobile,
      sidebarOpen: false,
      setSidebarOpen: vi.fn(),
    } as unknown as TerminalAppContextType;
    return render(<TerminalAppContext value={ctx}>{chrome}</TerminalAppContext>);
  }

  for (const mobile of [false, true]) {
    it(`renders the ${mobile ? "mobile" : "Canvas"} workspace chrome without a share control`, async () => {
      renderChrome(<TerminalWorkspaceChrome />, mobile);
      await settle();
      expect(screen.getByText("api")).toBeTruthy();
      expect(screen.queryByRole("button", { name: /^Share\b/i })).toBeNull();
    });

    it(`renders the ${mobile ? "mobile" : "Canvas"} embedded toolbar without a share control`, async () => {
      renderChrome(<TerminalEmbeddedToolbar />, mobile);
      await settle();
      expect(screen.queryByRole("button", { name: /^Share\b/i })).toBeNull();
    });
  }
});
