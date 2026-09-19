import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { SharedChatComposer, type SharedChatComposerState } from "@/components/collaboration/SharedChatComposer";

const selection = { instanceId: "claude_shared", model: "claude-opus-4-6" };

const state: SharedChatComposerState = {
  scope: {
    id: "10000000-0000-4000-8000-000000000001",
    ownerId: "user_owner",
    kind: "chat",
    resourceId: "chat_one",
    membershipMode: "direct",
    lifecycle: "shared",
    revision: "1",
    authEpoch: "1",
    authorityGeneration: "1",
    role: "editor",
    capabilities: {
      read: true, discuss: true, manageMembers: false, requestAi: true,
      observeTerminal: false, controlTerminal: false, stopTerminal: false,
    },
  },
  aiAvailability: "available",
  aiRequests: [],
  approvals: [],
  aiDraft: "",
  sending: false,
  error: "",
  aiError: "",
};

describe("SharedChatComposer", () => {
  it("behaves like the ordinary Chat composer without an Ask AI mode", () => {
    const onDraftChange = jest.fn();
    const onRequestAi = jest.fn(async () => undefined);
    render(<SharedChatComposer state={state} actorId="user_editor"
      onDraftChange={onDraftChange} onRequestAi={onRequestAi}
      onControlAi={jest.fn(async () => undefined)} onDecideApproval={jest.fn(async () => undefined)} />);

    expect(screen.queryByLabelText("Ask AI mode")).toBeNull();
    expect(screen.queryByLabelText("Discussion mode")).toBeNull();
    fireEvent.changeText(screen.getByLabelText("Message Chat"), "Summarize this");
    expect(onDraftChange).toHaveBeenCalledWith("Summarize this");
    expect(screen.getByLabelText("Send")).toBeTruthy();
  });

  it("keeps queue details hidden until ordering or approval needs attention", () => {
    const props = {
      actorId: "user_editor",
      onDraftChange: jest.fn(),
      onRequestAi: jest.fn(async () => undefined),
      onControlAi: jest.fn(async () => undefined),
      onDecideApproval: jest.fn(async () => undefined),
    };
    const { rerender } = render(<SharedChatComposer state={{ ...state, aiRequests: [{
      id: "request_one",
      chatId: "chat_one",
      acceptedSequence: "1",
      actor: { actorId: "user_editor", displayName: "Ada" },
      state: "running",
      text: "First",
      selection,
      acceptedAt: "2026-09-17T12:00:00.000Z",
      updatedAt: "2026-09-17T12:00:00.000Z",
    }] }} {...props} />);
    expect(screen.queryByLabelText("Shared AI queue")).toBeNull();

    rerender(<SharedChatComposer state={{ ...state, aiRequests: [
      {
        id: "request_one", chatId: "chat_one", acceptedSequence: "1",
        actor: { actorId: "user_editor", displayName: "Ada" }, state: "running", text: "First",
        selection, acceptedAt: "2026-09-17T12:00:00.000Z", updatedAt: "2026-09-17T12:00:00.000Z",
      },
      {
        id: "request_two", chatId: "chat_one", acceptedSequence: "2",
        actor: { actorId: "user_owner", displayName: "Nima" }, state: "queued", text: "Second",
        selection, acceptedAt: "2026-09-17T12:01:00.000Z", updatedAt: "2026-09-17T12:01:00.000Z",
      },
    ] }} {...props} />);
    expect(screen.getByLabelText("Shared AI queue")).toBeTruthy();

    rerender(<SharedChatComposer state={{ ...state, aiRequests: [{
      id: "request_retry", chatId: "chat_one", acceptedSequence: "3",
      actor: { actorId: "user_editor", displayName: "Ada" }, state: "interrupted", text: "Retry me",
      selection, acceptedAt: "2026-09-17T12:02:00.000Z", updatedAt: "2026-09-17T12:02:00.000Z",
    }] }} {...props} />);
    expect(screen.getByLabelText("Shared AI queue")).toBeTruthy();
    expect(screen.getByLabelText("Retry request 3")).toBeTruthy();
  });
});
