// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { LegacyLiveAccessButton } from "../../packages/ui/src/collaboration/LegacyLiveAccessButton";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true; });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.open = false; });
});

const scopeId = "10000000-0000-4000-8000-000000000001";
const organizationId = "org_matrix_team";
const resourceId = "chat_legacy";
const scope = {
  id: scopeId,
  ownerId: "user_owner",
  organizationId,
  kind: "chat" as const,
  resourceId,
  membershipMode: "direct" as const,
  lifecycle: "shared" as const,
  revision: "3",
  authEpoch: "2",
  authorityGeneration: "1",
  role: "owner" as const,
  capabilities: {
    read: true,
    discuss: true,
    manageMembers: true,
    requestAi: true,
    observeTerminal: false,
    controlTerminal: false,
    stopTerminal: false,
  },
};

describe("legacy live access", () => {
  it("stays hidden and never creates a scope when the resource was never shared", async () => {
    const api = {
      baseUrl: "https://app.matrix-os.com",
      get: vi.fn(),
      post: vi.fn(async () => ({
        eligible: true,
        resourceRevision: "7",
        confirmationToken: "a".repeat(64),
      })),
      patch: vi.fn(),
      delete: vi.fn(),
    };

    const view = render(<LegacyLiveAccessButton api={api} runtimeId="vps:owner" organizationId={organizationId}
      kind="chat" resourceId={resourceId} resourceLabel="Chat" />);

    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      "/api/collaboration/runtimes/vps%3Aowner/scopes/preflight",
      { kind: "chat", resourceId, organizationId },
    ));
    expect(view.container).toBeEmptyDOMElement();
    expect(api.post.mock.calls.some(([path]) => path === "/api/collaboration/runtimes/vps%3Aowner/scopes")).toBe(false);
  });

  it("opens revoke-capable management for an existing scope without offering new grants", async () => {
    const api = {
      baseUrl: "https://app.matrix-os.com",
      get: vi.fn(async (path: string) => {
        if (path.endsWith("/members")) return { members: [] };
        if (path.endsWith("/grants")) return [{
          id: "20000000-0000-4000-8000-000000000001",
          scopeId,
          organizationId,
          audience: { kind: "organization" as const },
          preset: "viewer" as const,
          state: "active" as const,
          policyVersion: "v1",
          revision: "1",
          createdAt: "2026-10-01T00:00:00.000Z",
          updatedAt: "2026-10-01T00:00:00.000Z",
        }];
        if (path.startsWith("/api/organizations/")) return { members: [] };
        return scope;
      }),
      post: vi.fn(async (path: string) => path.endsWith("/preflight")
        ? { eligible: false, reason: "active_work", resourceRevision: "7", existingScopeId: scopeId, existingLifecycle: "shared" }
        : { resourceKind: "chat", status: "available" }),
      patch: vi.fn(),
      delete: vi.fn(),
    };

    render(<LegacyLiveAccessButton api={api} runtimeId="vps:owner" organizationId={organizationId}
      kind="chat" resourceId={resourceId} resourceLabel="Chat" />);

    const manage = await screen.findByRole("button", { name: "Manage legacy Chat access" });
    fireEvent.click(manage);

    expect(await screen.findByRole("dialog", { name: "Manage legacy live access" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Revoke" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Grant access" })).toBeNull();
    expect(api.get.mock.calls.some(([path]) => String(path).startsWith("/api/organizations/"))).toBe(false);
    expect(api.post.mock.calls.some(([path]) => path === "/api/collaboration/runtimes/vps%3Aowner/scopes")).toBe(false);
  });
});
