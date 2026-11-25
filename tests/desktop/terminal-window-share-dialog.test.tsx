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
  // These tabs are shared on their own: the whole computer is not.
  const get = api.get;
  const wrapped = { ...api, get: async (path: string) => path.endsWith("/terminal/team/computer") ? { shared: false, canOpenTabs: false } : get?.(path) };
  return {
    api: () => wrapped as CollaborationDirectApi,
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

  it("keeps the share and Stop sharing when stopping fails partway (Greptile on #3679)", async () => {
    const post = vi.fn(async () => ({ eligible: true, resourceRevision: "4", confirmationToken: "c".repeat(64), existingScopeId: scopeId, existingLifecycle: "shared" }));
    const grant = { id: "20000000-0000-4000-8000-000000000001", scopeId, organizationId: "org_team", audience: { kind: "organization" }, preset: "viewer", state: "active", policyVersion: "preset-v1", revision: "1", createdAt: "2026-11-24T10:00:00.000Z", updatedAt: "2026-11-24T10:00:00.000Z" };
    const get = vi.fn(async (path: string) => path.endsWith("/grants") ? [grant] : path.includes("/members") ? { members: [] } : scope());
    const remove = vi.fn(async () => { throw new Error("CollaborationUnavailable"); });
    render(<ShareTerminalDialog target={target} platformHost={platformHost} team={teamWith({ post, get, delete: remove, patch: vi.fn(async () => ({})), put: vi.fn() })} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Stop sharing" }));
    expect(await screen.findByText(/Couldn't stop sharing/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop sharing" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Share terminal" })).toBeNull();
  });

  it("offers Retry when access saved but the typing setting did not (Greptile on #3679)", async () => {
    const post = vi.fn(async () => ({ eligible: true, resourceRevision: "4", confirmationToken: "c".repeat(64), existingScopeId: scopeId, existingLifecycle: "shared" }));
    const get = vi.fn(async (path: string) => path.endsWith("/grants") ? [] : path.includes("/members") ? { members: [] } : scope());
    const patch = vi.fn().mockRejectedValueOnce(new Error("CollaborationUnavailable")).mockResolvedValue({});
    render(<ShareTerminalDialog target={target} platformHost={platformHost} team={teamWith({ post, get, delete: vi.fn(), patch, put: vi.fn() })} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText(/Editors may not be able to type/)).toBeNull());
  });

  it("finds a share made in the person's second organization (Greptile on #3679)", async () => {
    const post = vi.fn(async (_path: string, body?: unknown) => {
      if ((body as { organizationId: string }).organizationId === "org_team") throw new Error("CollaborationUnavailable");
      return { eligible: true, resourceRevision: "4", confirmationToken: "c".repeat(64), existingScopeId: scopeId, existingLifecycle: "shared" };
    });
    const get = vi.fn(async (path: string) => path.endsWith("/grants") ? [] : path.includes("/members") ? { members: [] } : { ...scope(), organizationId: "org_other" });
    const team: TeamCollaboration = {
      api: () => ({ post, get, delete: vi.fn(), patch: vi.fn(async () => ({})), put: vi.fn() }) as unknown as CollaborationDirectApi,
      organizations: async () => [{ organizationId: "org_team", name: "Acme" }, { organizationId: "org_other", name: "Other" }],
    };
    render(<ShareTerminalDialog target={target} platformHost={platformHost} team={team} onClose={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "Stop sharing" })).toBeTruthy();
    expect(post).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ organizationId: "org_other" }));
  });

  it("keeps a stopped share stopped when a typing retry finishes late (Greptile on #3679)", async () => {
    const post = vi.fn(async () => ({ eligible: true, resourceRevision: "4", confirmationToken: "c".repeat(64), existingScopeId: scopeId, existingLifecycle: "shared" }));
    const get = vi.fn(async (path: string) => path.endsWith("/grants") ? [] : path.includes("/members") ? { members: [] } : scope());
    let finishRetry!: () => void;
    const patch = vi.fn()
      .mockRejectedValueOnce(new Error("CollaborationUnavailable"))
      .mockImplementationOnce(() => new Promise((resolve) => { finishRetry = () => resolve({}); }))
      .mockResolvedValue({});
    render(<ShareTerminalDialog target={target} platformHost={platformHost} team={teamWith({ post, get, delete: vi.fn(), patch, put: vi.fn() })} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Stop sharing" }));
    expect(await screen.findByRole("button", { name: "Share terminal" })).toBeTruthy();
    finishRetry();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("button", { name: "Stop sharing" })).toBeNull();
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
