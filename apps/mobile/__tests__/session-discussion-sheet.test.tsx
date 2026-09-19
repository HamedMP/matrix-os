const mockFetchDiscussion = jest.fn();
const mockFetchDiscussionState = jest.fn();
const mockPostDiscussion = jest.fn();
const mockUpdateDiscussionState = jest.fn();

jest.mock("@/lib/requests/collaboration", () => ({
  fetchSessionDiscussion: (...args: unknown[]) => mockFetchDiscussion(...args),
  fetchSessionDiscussionUserState: (...args: unknown[]) => mockFetchDiscussionState(...args),
  postSessionDiscussion: (...args: unknown[]) => mockPostDiscussion(...args),
  updateSessionDiscussionReadState: (...args: unknown[]) => mockUpdateDiscussionState(...args),
}));

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { SessionDiscussionSheet } from "@/components/collaboration/SessionDiscussionSheet";

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
  role: "editor" as const,
  capabilities: {
    read: true, discuss: true, manageMembers: false, requestAi: true,
    observeTerminal: false, controlTerminal: false, stopTerminal: false,
  },
};

describe("SessionDiscussionSheet", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchDiscussion.mockResolvedValue({
      latestSequence: "1",
      messages: [{
        id: "note_one", scopeId: scope.id, sequence: "1",
        actor: { actorId: "user_owner", displayName: "Nima" }, text: "Review the launch notes",
        createdAt: "2026-09-17T12:00:00.000Z",
      }],
    });
    mockFetchDiscussionState.mockResolvedValue({ readThroughSeq: "0" });
    mockUpdateDiscussionState.mockResolvedValue({ readThroughSeq: "1" });
    mockPostDiscussion.mockResolvedValue({
      id: "note_two", scopeId: scope.id, sequence: "2",
      actor: { actorId: "user_editor", displayName: "Ada" }, text: "Looks good",
      createdAt: "2026-09-17T12:01:00.000Z",
    });
  });

  it("keeps human notes separate from AI prompts in a dismissible sheet", async () => {
    const onClose = jest.fn();
    render(<SessionDiscussionSheet open scope={scope} actorId="user_editor" getToken={async () => "clerk-token"} onClose={onClose} />);

    expect(await screen.findByText("Review the launch notes")).toBeTruthy();
    expect(screen.getByText("Notes for people in this session—not prompts for AI.")).toBeTruthy();
    fireEvent.changeText(screen.getByLabelText("Add a discussion note"), "Looks good");
    fireEvent.press(screen.getByLabelText("Post note"));
    await waitFor(() => expect(mockPostDiscussion).toHaveBeenCalledWith(
      "clerk-token", scope.id, scope.revision, "Looks good", expect.any(String),
    ));
    expect(await screen.findByText("Looks good")).toBeTruthy();
    fireEvent.press(screen.getByLabelText("Close discussion panel"));
    expect(onClose).toHaveBeenCalled();
  });
});
