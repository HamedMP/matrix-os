// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { SessionAccessControl } from "../../packages/ui/src/collaboration/SessionAccessControl";

const scope = {
  id: "10000000-0000-4000-8000-000000000001",
  ownerId: "user_owner",
  kind: "chat" as const,
  resourceId: "chat_shared",
  membershipMode: "direct" as const,
  lifecycle: "shared" as const,
  revision: "2",
  authEpoch: "2",
  authorityGeneration: "1",
  role: "owner" as const,
  capabilities: { read: true, discuss: true, manageMembers: true, requestAi: true,
    observeTerminal: false, controlTerminal: false, stopTerminal: false },
};
const members = [{
  actor: { actorId: "user_owner", displayName: "Nima" },
  role: "owner" as const,
  status: "accepted" as const,
  revision: "1",
  joinedAt: "2026-09-17T12:00:00.000Z",
  updatedAt: "2026-09-17T12:00:00.000Z",
}];

function api() {
  return {
    baseUrl: "https://app.matrix-os.com",
    get: vi.fn(async (path: string) => path.endsWith("/members") ? { members } : scope),
    post: vi.fn(),
    delete: vi.fn(),
  };
}

describe("SessionAccessControl", () => {
  it("uses a compact summary and discloses owner management at the second level", async () => {
    render(<SessionAccessControl api={api()} scope={scope} />);
    fireEvent.click(screen.getByRole("button", { name: "Collaboration access" }));
    expect(await screen.findByRole("dialog", { name: "Collaboration access summary" })).toBeVisible();
    expect(await screen.findByText("Nima")).toBeVisible();
    expect(screen.getByRole("button", { name: "Manage access" })).toBeVisible();
  });

  it("does not offer management to viewers or inherited members", async () => {
    render(<SessionAccessControl api={api()} scope={{ ...scope, role: "viewer", membershipMode: "inherited",
      capabilities: { ...scope.capabilities, discuss: false, manageMembers: false, requestAi: false } }} />);
    fireEvent.click(screen.getByRole("button", { name: "Collaboration access" }));
    expect(await screen.findByText("Project access")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Manage access" })).toBeNull();
  });

  it("moves focus into the summary and returns it on close", async () => {
    render(<SessionAccessControl api={api()} scope={scope} />);
    const trigger = screen.getByRole("button", { name: "Collaboration access" });
    fireEvent.click(trigger);
    const close = await screen.findByRole("button", { name: "Close access summary" });
    await waitFor(() => expect(close).toHaveFocus());
    fireEvent.click(close);
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
