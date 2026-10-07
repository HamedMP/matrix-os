// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { TerminalSharingButton } from "../../packages/ui/src/collaboration/TerminalSharingButton";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true; });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.open = false; });
});

const scopeId = "10000000-0000-4000-8000-000000000001";

describe("terminal sharing button", () => {
  it("shows Manage access only for an existing standalone terminal scope", async () => {
    const scope = {
      id: scopeId, ownerId: "user_owner", kind: "terminal", resourceId: "terminal_release",
      membershipMode: "direct", lifecycle: "shared", revision: "1", authEpoch: "1",
      authorityGeneration: "1", role: "owner",
      capabilities: { read: true, discuss: false, manageMembers: true, requestAi: false,
        observeTerminal: true, controlTerminal: true, stopTerminal: true },
    };
    const api = {
      baseUrl: "https://app.matrix-os.com",
      get: vi.fn(async (path: string) => path.endsWith("/members") ? { members: [] } : scope),
      post: vi.fn(async (path: string) => path.endsWith("/preflight")
        ? { eligible: false, reason: "unsupported", resourceRevision: "4", existingScopeId: scopeId, existingLifecycle: "shared" }
        : undefined),
      patch: vi.fn(), delete: vi.fn(),
    };
    render(<TerminalSharingButton api={api} runtimeId="vps:runtime_owner" organizationId="org_matrix_team" terminalId="terminal_release" />);
    fireEvent.click(await screen.findByRole("button", { name: "Manage terminal access" }));
    expect(await screen.findByRole("dialog", { name: "Manage access" })).toBeVisible();
    expect(screen.getByText(/ongoing terminal/i)).toBeVisible();
    expect(api.post).not.toHaveBeenCalledWith(expect.stringMatching(/\/scopes$/), expect.anything());
  });

  it("treats a missing organization as unresolved instead of telling people to join one", () => {
    const api = { baseUrl: "https://app.matrix-os.com", get: vi.fn(), post: vi.fn(), delete: vi.fn() };
    render(<TerminalSharingButton api={api} runtimeId="runtime_owner" organizationId={null} terminalId="terminal_release" />);

    expect(screen.queryByRole("button", { name: /terminal/i })).toBeNull();
    expect(api.post).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not expose a new standalone terminal share control", async () => {
    const api = {
      baseUrl: "https://app.matrix-os.com",
      get: vi.fn(),
      post: vi.fn(async () => ({ eligible: false, reason: "unsupported", resourceRevision: "1" })),
      delete: vi.fn(),
    };
    render(<TerminalSharingButton api={api} runtimeId="runtime_owner" organizationId="org_matrix_team" terminalId="legacy_terminal" />);
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button", { name: /terminal/i })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
