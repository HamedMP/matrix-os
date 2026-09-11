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
  it("requires whole-output confirmation before creating the standalone scope", async () => {
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
        ? { eligible: true, resourceRevision: "4", confirmationToken: "a".repeat(64) }
        : scope),
      patch: vi.fn(), delete: vi.fn(),
    };
    render(<TerminalSharingButton api={api} runtimeId="runtime_owner" terminalId="terminal_release" />);
    fireEvent.click(screen.getByRole("button", { name: "Share terminal" }));
    expect(await screen.findByRole("heading", { name: "Share this whole terminal?" })).toBeVisible();
    expect(screen.getByText(/complete retained output and future live output/i)).toBeVisible();
    expect(screen.getByText(/does not share its parent project/i)).toBeVisible();
    expect(api.post).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Confirm and invite" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      "/api/collaboration/runtimes/runtime_owner/scopes",
      expect.objectContaining({
        kind: "terminal",
        resourceId: "terminal_release",
        expectedRevision: "4",
        confirmationToken: "a".repeat(64),
      }),
    ));
    expect(await screen.findByRole("dialog", { name: "Invite collaborators" })).toBeVisible();
    expect(screen.getByText(/ongoing terminal/i)).toBeVisible();
  });

  it("leaves an unrestricted terminal intact when preflight rejects it", async () => {
    const api = {
      baseUrl: "https://app.matrix-os.com",
      get: vi.fn(),
      post: vi.fn(async () => ({ eligible: false, reason: "unsupported", resourceRevision: "1" })),
      delete: vi.fn(),
    };
    render(<TerminalSharingButton api={api} runtimeId="runtime_owner" terminalId="legacy_terminal" />);
    fireEvent.click(screen.getByRole("button", { name: "Share terminal" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("cannot be shared safely");
    expect(api.post).toHaveBeenCalledTimes(1);
  });
});
