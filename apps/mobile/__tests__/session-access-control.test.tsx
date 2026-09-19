const mockFetchScope = jest.fn();
const mockFetchMembers = jest.fn();
const mockInvite = jest.fn();
const mockChangeRole = jest.fn();
const mockRemove = jest.fn();
const mockRevoke = jest.fn();

jest.mock("@/lib/requests/collaboration", () => ({
  fetchCollaborationScope: (...args: unknown[]) => mockFetchScope(...args),
  fetchCollaborationMembers: (...args: unknown[]) => mockFetchMembers(...args),
  inviteCollaborationMember: (...args: unknown[]) => mockInvite(...args),
  changeCollaborationMemberRole: (...args: unknown[]) => mockChangeRole(...args),
  removeCollaborationMember: (...args: unknown[]) => mockRemove(...args),
  revokeCollaborationInvitation: (...args: unknown[]) => mockRevoke(...args),
}));

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { SessionAccessControl } from "@/components/collaboration/SessionAccessControl";

const scope = {
  id: "10000000-0000-4000-8000-000000000001",
  ownerId: "user_owner",
  kind: "chat" as const,
  resourceId: "chat_one",
  membershipMode: "direct" as const,
  lifecycle: "shared" as const,
  revision: "1",
  authEpoch: "1",
  authorityGeneration: "1",
  role: "owner" as const,
  capabilities: {
    read: true, discuss: true, manageMembers: true, requestAi: true,
    observeTerminal: false, controlTerminal: false, stopTerminal: false,
  },
};
const members = [{
  actor: { actorId: "user_owner", displayName: "Nima" }, role: "owner" as const, status: "accepted" as const,
  revision: "1", joinedAt: "2026-09-17T12:00:00.000Z", updatedAt: "2026-09-17T12:00:00.000Z",
}, {
  actor: { actorId: "user_editor", displayName: "Ada" }, role: "editor" as const, status: "accepted" as const,
  revision: "1", joinedAt: "2026-09-17T12:00:00.000Z", updatedAt: "2026-09-17T12:00:00.000Z",
}];

describe("SessionAccessControl", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchScope.mockResolvedValue(scope);
    mockFetchMembers.mockResolvedValue({ members });
    mockInvite.mockResolvedValue({});
    mockChangeRole.mockResolvedValue({});
    mockRemove.mockResolvedValue({});
    mockRevoke.mockResolvedValue({});
  });

  it("progressively reveals members and owner-only access management", async () => {
    render(<SessionAccessControl scope={scope} getToken={async () => "clerk-token"} />);
    fireEvent.press(screen.getByLabelText("Collaboration access"));
    expect(await screen.findByText("Ada")).toBeTruthy();
    fireEvent.press(screen.getByLabelText("Manage access"));
    fireEvent.changeText(screen.getByLabelText("Email or username"), "grace@example.com");
    fireEvent.press(screen.getByLabelText("Invite as viewer"));
    fireEvent.press(screen.getByLabelText("Send invitation"));
    await waitFor(() => expect(mockInvite).toHaveBeenCalledWith(
      "clerk-token", scope.id, "grace@example.com", "viewer", "1", expect.any(String),
    ));
    fireEvent.press(screen.getByLabelText("Change role for Ada"));
    await waitFor(() => expect(mockChangeRole).toHaveBeenCalledWith(
      "clerk-token", scope.id, "user_editor", "viewer", "1", "1", expect.any(String),
    ));
  });
});
