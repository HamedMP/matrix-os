// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollaborationDirectApi } from "@matrix-os/ui";
import { ShareTerminalDialog } from "@desktop/renderer/src/features/terminal-window/share/ShareTerminalDialog";
import { TeamPaneControl } from "@desktop/renderer/src/features/terminal-window/share/TeamPaneControl";
import type { TeamCollaboration } from "@desktop/renderer/src/features/terminal-window/share/use-team-collaboration";

const platformHost = "https://app.matrix-os.com";
const machineId = "11111111-1111-4111-8111-111111111111";
const scopeId = "10000000-0000-4000-8000-000000000001";
const terminalId = `tws_${"3".repeat(32)}:tt_${"4".repeat(32)}`;
const target = { slot: "primary", terminalId, title: "api-server", computerLabel: "team-dev-1" };

function scope() {
  return {
    id: scopeId, ownerId: "user_owner", organizationId: "org_team", kind: "terminal", resourceId: terminalId,
    lifecycle: "shared", membershipMode: "direct", revision: "3", role: "owner", authEpoch: "1", authorityGeneration: "1",
    capabilities: { read: true, discuss: true, manageMembers: true, requestAi: false },
  };
}

function teamWith(api: Partial<CollaborationDirectApi>): TeamCollaboration {
  return {
    api: () => api as CollaborationDirectApi,
    organizations: async () => [{ organizationId: "org_team", name: "Acme" }],
  };
}

describe("Share terminal dialog (spec 2710 J1)", () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
    HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes("/api/system/info")) {
        return new Response(JSON.stringify({ runtime: { machineId }, capabilities: { collaboration: true } }), { headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
    }));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("warns that a shared terminal is full shell access, then shares it under the chosen computer name", async () => {
    const post = vi.fn(async (path: string) => path.endsWith("/preflight")
      ? { eligible: true, resourceRevision: "4", confirmationToken: "c".repeat(64) }
      : scope());
    const put = vi.fn(async () => ({}));
    const get = vi.fn(async (path: string) => path.endsWith("/grants") ? [] : path.includes("/members") ? { members: [] } : scope());
    render(<ShareTerminalDialog target={target} platformHost={platformHost} team={teamWith({ post, put, get, delete: vi.fn(), patch: vi.fn() })} onClose={vi.fn()} />);
    expect((await screen.findByRole("note")).textContent).toContain("full shell access");
    const name = await screen.findByRole("textbox", { name: "Computer name teammates see" });
    fireEvent.change(name, { target: { value: "Nima's dev box" } });
    fireEvent.click(screen.getByRole("button", { name: "Share terminal" }));
    await waitFor(() => expect(put).toHaveBeenCalledWith(`/api/collaboration/scopes/${scopeId}/terminal/team/label`, { computerLabel: "Nima's dev box" }));
    expect(post).toHaveBeenCalledWith(`/api/collaboration/runtimes/${encodeURIComponent(`vps:${machineId}`)}/scopes`, expect.objectContaining({ kind: "terminal", resourceId: terminalId }));
    expect(await screen.findByRole("region", { name: "Share with organization" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop sharing" })).toBeTruthy();
  });

  it("opens an already shared terminal on its access list without creating anything", async () => {
    const post = vi.fn(async () => ({ eligible: true, resourceRevision: "4", confirmationToken: "c".repeat(64), existingScopeId: scopeId, existingLifecycle: "shared" }));
    const get = vi.fn(async (path: string) => path.endsWith("/grants") ? [] : path.includes("/members") ? { members: [] } : scope());
    render(<ShareTerminalDialog target={target} platformHost={platformHost} team={teamWith({ post, get, delete: vi.fn(), patch: vi.fn(), put: vi.fn() })} onClose={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "Stop sharing" })).toBeTruthy();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("asks a person with no organization to join one first", async () => {
    const team: TeamCollaboration = { api: () => ({}) as CollaborationDirectApi, organizations: async () => [] };
    render(<ShareTerminalDialog target={target} platformHost={platformHost} team={team} onClose={vi.fn()} />);
    expect(await screen.findByText(/Join or create an organization/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Share terminal" })).toBeNull();
  });
});

describe("Shared pane controls (spec 2710 J5)", () => {
  afterEach(() => { cleanup(); });
  const entry = {
    ref: { workspaceId: `tws_${"3".repeat(32)}`, tabId: `tt_${"4".repeat(32)}` }, scopeId,
    inputMode: "shared" as const,
    participants: [
      { actorId: "user_owner", displayName: "Nima Naderi", role: "owner" as const, connections: 0 },
      { actorId: "user_yuhan", displayName: "Yuhan", role: "editor" as const, connections: 1, typingAt: "2026-11-24T10:00:00.000Z" },
    ],
    marks: [],
  };

  it("shows who is in the tab and lets the owner take control and hand it back", async () => {
    const onInputMode = vi.fn(async () => undefined);
    const { rerender } = render(<TeamPaneControl entry={entry} title="api-server" onShare={vi.fn()} onInputMode={onInputMode} />);
    expect(screen.getByRole("img", { name: /Nima Naderi \(owner\), Yuhan \(typing\)/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Take control" }));
    await waitFor(() => expect(onInputMode).toHaveBeenCalledWith(scopeId, "owner"));
    rerender(<TeamPaneControl entry={{ ...entry, inputMode: "owner" }} title="api-server" onShare={vi.fn()} onInputMode={onInputMode} />);
    fireEvent.click(screen.getByRole("button", { name: "Hand back" }));
    await waitFor(() => expect(onInputMode).toHaveBeenLastCalledWith(scopeId, "shared"));
  });

  it("offers only Share on a tab nobody is watching", () => {
    const onShare = vi.fn();
    render(<TeamPaneControl entry={undefined} title="api-server" onShare={onShare} onInputMode={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Share api-server" }));
    expect(onShare).toHaveBeenCalled();
  });
});
