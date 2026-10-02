import type { ReactNode } from "react";

const mockSendMessage = jest.fn();
let mockActiveChatId: string | null = null;
let mockDetail: unknown;
let mockCatalog: unknown;
let mockComputer: unknown;
let mockSendPending = false;

jest.mock("@clerk/clerk-expo", () => ({
  useAuth: () => ({ isSignedIn: true }),
  useUser: () => ({
    isLoaded: true,
    user: { firstName: "Shubham", fullName: "Shubham Zanwar", username: "shubham" },
  }),
}));

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

jest.mock("@/lib/canonical-chat-session-context", () => ({
  useCanonicalChatSession: () => ({
    activeChatId: mockActiveChatId,
    selectionOverride: null,
    setSelectionOverride: jest.fn(),
    selectedProjectId: null,
    setSelectedProjectId: jest.fn(),
    bindDraftChatId: jest.fn(),
  }),
}));

jest.mock("@/lib/queries/use-canonical-chat-detail", () => ({
  useCanonicalChatDetail: () => ({ detail: mockDetail, computer: mockComputer }),
}));

jest.mock("@/lib/queries/use-chat-provider-catalog", () => ({
  useChatProviderCatalog: () => ({ catalog: mockCatalog }),
}));

jest.mock("@/lib/queries/use-projects", () => ({
  useProjects: () => ({ projects: [], isPending: false, isError: false }),
}));

jest.mock("@/lib/queries/use-send-chat-message", () => ({
  useSendChatMessage: () => ({ mutate: mockSendMessage, isPending: mockSendPending }),
}));

// The contracts barrel pulls in ESM-only micromark, which Jest cannot load.
jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));

jest.mock("@expo/ui", () => {
  const React = jest.requireActual("react") as typeof import("react");
  const { View } = jest.requireActual("react-native") as typeof import("react-native");
  return {
    Host: ({ children }: { children: ReactNode }) => React.createElement(View, null, children),
    Picker: () => null,
  };
});

import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { Alert, StyleSheet as NativeStyleSheet } from "react-native";
import * as Clipboard from "expo-clipboard";

import ChatScreen from "../app/(drawer)/index";

describe("drawer home screen", () => {
  it("expands the exact tool command and bounded result", () => {
    mockActiveChatId = "chat_tools";
    mockDetail = { record: { chat: { id: mockActiveChatId } }, turns: [],
      runs: [{ id: "run_tools", turnId: "cturn_tools", status: "running", selection: { model: "test" }, createdAt: "2026-09-20T00:00:00.000Z" }],
      messages: [], activities: [
        { id: "activity_tools", runId: "run_tools", type: "agent.activity", activityId: "tool_tests", kind: "command", label: "Run command", status: "running", preview: "bun run test", previewKind: "command", detail: "Working directory: projects/demo" },
        { id: "activity_output", runId: "run_tools", type: "tool.output", toolCallId: "tool_tests", text: "12 tests passed", truncated: false },
      ] };
    render(<ChatScreen />);
    fireEvent.press(screen.getByRole("button", { name: "Run command: bun run test" }));
    expect(screen.getByText(/12 tests passed/)).toBeTruthy();
  });

  afterEach(() => {
    mockActiveChatId = null;
    mockDetail = undefined;
    mockCatalog = undefined;
    mockComputer = undefined;
    mockSendPending = false;
    mockSendMessage.mockReset();
    jest.restoreAllMocks();
  });
  it("copies the displayed Native Mobile conversation ID by long-pressing its content", () => {
    mockActiveChatId = "chat_native_content";
    mockDetail = { record: { chat: { id: mockActiveChatId } }, runs: [], turns: [], activities: [],
      messages: [{ id: "msg_native_copy", chatId: mockActiveChatId, role: "user", state: "committed", seq: 1,
        parts: [{ type: "text", text: "Inspect native failure" }], createdAt: "2026-09-09T00:00:00.000Z" }] };
    const alert = jest.spyOn(Alert, "alert");
    render(<ChatScreen />);
    fireEvent(screen.getByText("Inspect native failure"), "longPress");
    const action = alert.mock.calls[0]?.[2]?.find((button) => button.text === "Copy chat ID");
    expect(action).toBeDefined();
    action!.onPress?.();
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith("chat_native_content");
  });

  it("uses the Matrix rabbit artwork for its empty-state mark", () => {
    render(<ChatScreen />);

    expect(screen.getByText("Welcome back Shubham")).toBeTruthy();
    const rabbitStyle = NativeStyleSheet.flatten(screen.getByTestId("home-rabbit-mark").props.style);
    expect(rabbitStyle).toMatchObject({ width: 68, height: 68 });
    const containerStyle = NativeStyleSheet.flatten(screen.getByTestId("home-rabbit-container").props.style);
    expect(containerStyle).toMatchObject({ width: 68, height: 68 });
  });
  describe("optimistic send", () => {
    const catalog = {
      instances: [{
        id: "instance_test",
        availability: "available",
        defaultSelection: { instanceId: "instance_test", model: "test" },
        models: [{ id: "test", availability: "available" }],
        options: [],
        supports: { interactionModes: ["default"], permissionModes: ["supervised"] },
      }],
    };

    function sentMessage(id: string, seq: number, text: string, chatId: string) {
      return { id, chatId, role: "user", state: "committed", seq,
        parts: [{ type: "text", text }], createdAt: "2026-09-09T00:00:00.000Z" };
    }

    /** The turn the server records for a send: it echoes the send's request id. */
    function admittedTurn(clientRequestId: string, inputMessageId: string, chatId: string) {
      return { id: `cturn_${inputMessageId}`, chatId, clientRequestId, inputMessageId };
    }

    function detailFor(
      chatId: string,
      messages: ReturnType<typeof sentMessage>[],
      turns: ReturnType<typeof admittedTurn>[] = [],
    ) {
      return { record: { chat: { id: chatId, revision: 4 } }, runs: [], turns, activities: [], messages };
    }

    function sendDraft(text: string) {
      fireEvent.changeText(screen.getByLabelText("Message Matrix"), text);
      fireEvent.press(screen.getByRole("button", { name: "Send message" }));
    }

    beforeEach(() => { mockCatalog = catalog; });

    it("shows the message as sent and clears the composer without waiting for the server", () => {
      render(<ChatScreen />);
      sendDraft("Ship it");

      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      expect(mockSendMessage.mock.calls[0][0]).toMatchObject({ chatId: null, text: "Ship it" });
      expect(screen.getByText("Ship it")).toBeTruthy();
      expect(screen.getByLabelText("Message Matrix").props.value).toBe("");
      expect(screen.queryByText("Welcome back Shubham")).toBeNull();
    });

    it("puts the text back in the composer when the send fails", () => {
      render(<ChatScreen />);
      sendDraft("Ship it");

      act(() => { mockSendMessage.mock.calls[0][1].onError(new Error("offline")); });

      expect(screen.queryByText("Ship it")).toBeNull();
      expect(screen.getByLabelText("Message Matrix").props.value).toBe("Ship it");
      expect(screen.getByText("Welcome back Shubham")).toBeTruthy();
    });

    it("keeps text typed while a failed send was in flight", () => {
      render(<ChatScreen />);
      sendDraft("Ship it");
      fireEvent.changeText(screen.getByLabelText("Message Matrix"), "and tag it");

      act(() => { mockSendMessage.mock.calls[0][1].onError(new Error("offline")); });

      expect(screen.getByLabelText("Message Matrix").props.value).toBe("Ship it and tag it");
    });

    it("reuses the idempotency keys when the same text is retried after a failure", () => {
      render(<ChatScreen />);
      sendDraft("Ship it");
      act(() => { mockSendMessage.mock.calls[0][1].onError(new Error("offline")); });
      fireEvent.press(screen.getByRole("button", { name: "Send message" }));

      expect(mockSendMessage).toHaveBeenCalledTimes(2);
      const [first, retry] = mockSendMessage.mock.calls.map((call) => call[0]);
      expect(retry.chatRequestId).toBe(first.chatRequestId);
      expect(retry.turnRequestId).toBe(first.turnRequestId);
    });

    it("follows a draft into the chat created for it, then hands over to the server's copy", () => {
      const view = render(<ChatScreen />);
      sendDraft("Ship it");

      // The chat now exists and is bound, but its detail has not loaded yet.
      act(() => { mockSendMessage.mock.calls[0][0].onChatCreated("chat_new"); });
      mockActiveChatId = "chat_new";
      view.rerender(<ChatScreen />);
      expect(screen.getAllByText("Ship it")).toHaveLength(1);

      const { turnRequestId } = mockSendMessage.mock.calls[0][0];
      mockDetail = detailFor(
        "chat_new",
        [sentMessage("msg_new", 1, "Ship it", "chat_new")],
        [admittedTurn(turnRequestId, "msg_new", "chat_new")],
      );
      view.rerender(<ChatScreen />);
      expect(screen.getAllByText("Ship it")).toHaveLength(1);
    });

    it("is not replaced by the same text arriving from someone else", () => {
      mockActiveChatId = "chat_existing";
      mockDetail = detailFor("chat_existing", [sentMessage("msg_old", 1, "Ship it", "chat_existing")]);
      const view = render(<ChatScreen />);
      sendDraft("Ship it");

      expect(mockSendMessage.mock.calls[0][0]).toMatchObject({ chatId: "chat_existing", baseRevision: 4 });
      expect(screen.getAllByText("Ship it")).toHaveLength(2);

      // Another client sends the same words before this send is admitted: a
      // different message, so the pending one stays on screen.
      const theirs = sentMessage("msg_theirs", 2, "Ship it", "chat_existing");
      const old = sentMessage("msg_old", 1, "Ship it", "chat_existing");
      mockDetail = detailFor("chat_existing", [old, theirs], [admittedTurn("req_theirs", "msg_theirs", "chat_existing")]);
      view.rerender(<ChatScreen />);
      expect(screen.getAllByText("Ship it")).toHaveLength(3);

      // This send's own turn arrives: the server's copy replaces the pending one.
      const { turnRequestId } = mockSendMessage.mock.calls[0][0];
      mockDetail = detailFor("chat_existing", [old, theirs, sentMessage("msg_mine", 3, "Ship it", "chat_existing")], [
        admittedTurn("req_theirs", "msg_theirs", "chat_existing"),
        admittedTurn(turnRequestId, "msg_mine", "chat_existing"),
      ]);
      view.rerender(<ChatScreen />);
      expect(screen.getAllByText("Ship it")).toHaveLength(3);
    });

    it("returns a failed send's text to the chat it was sent in, not the one on screen", () => {
      mockActiveChatId = "chat_a";
      mockDetail = detailFor("chat_a", []);
      const view = render(<ChatScreen />);
      sendDraft("Ship it");

      // The user opens another chat while the send is in flight, and it fails.
      mockActiveChatId = "chat_b";
      mockDetail = detailFor("chat_b", []);
      view.rerender(<ChatScreen />);
      act(() => { mockSendMessage.mock.calls[0][1].onError(new Error("offline")); });
      expect(screen.getByLabelText("Message Matrix").props.value).toBe("");

      // Back in the original chat, the text is waiting in the composer.
      mockActiveChatId = "chat_a";
      mockDetail = detailFor("chat_a", []);
      view.rerender(<ChatScreen />);
      expect(screen.getByLabelText("Message Matrix").props.value).toBe("Ship it");
      expect(screen.queryByText("Ship it")).toBeNull();
    });

    it("keeps a failed send's text apart from a draft typed in another chat", () => {
      mockActiveChatId = "chat_a";
      mockDetail = detailFor("chat_a", []);
      const view = render(<ChatScreen />);
      sendDraft("Ship it");

      // While the send is in flight, the user starts a message in another chat.
      mockActiveChatId = "chat_b";
      mockDetail = detailFor("chat_b", []);
      view.rerender(<ChatScreen />);
      fireEvent.changeText(screen.getByLabelText("Message Matrix"), "note for B");
      act(() => { mockSendMessage.mock.calls[0][1].onError(new Error("offline")); });
      expect(screen.getByLabelText("Message Matrix").props.value).toBe("note for B");

      mockActiveChatId = "chat_a";
      mockDetail = detailFor("chat_a", []);
      view.rerender(<ChatScreen />);
      expect(screen.getByLabelText("Message Matrix").props.value).toBe("Ship it");

      mockActiveChatId = "chat_b";
      mockDetail = detailFor("chat_b", []);
      view.rerender(<ChatScreen />);
      expect(screen.getByLabelText("Message Matrix").props.value).toBe("note for B");
    });

    it("starts with an empty composer and transcript on another computer", () => {
      mockComputer = { handle: "amin", runtimeSlot: "primary", gatewayPath: "/vm/amin" };
      const view = render(<ChatScreen />);
      sendDraft("Ship it");
      fireEvent.changeText(screen.getByLabelText("Message Matrix"), "and tag it");

      mockComputer = { handle: "amin", runtimeSlot: "secondary", gatewayPath: "/vm/amin?runtime=secondary" };
      view.rerender(<ChatScreen />);
      expect(screen.queryByText("Ship it")).toBeNull();
      expect(screen.getByLabelText("Message Matrix").props.value).toBe("");

      // The send made on the previous computer fails: its text stays out of this one.
      act(() => { mockSendMessage.mock.calls[0][1].onError(new Error("offline")); });
      expect(screen.getByLabelText("Message Matrix").props.value).toBe("");
    });

    it("does not show the pending message in a different chat", () => {
      mockActiveChatId = "chat_existing";
      mockDetail = detailFor("chat_existing", []);
      const view = render(<ChatScreen />);
      sendDraft("Ship it");

      mockActiveChatId = "chat_other";
      mockDetail = detailFor("chat_other", []);
      view.rerender(<ChatScreen />);
      expect(screen.queryByText("Ship it")).toBeNull();
    });

    it("does not start a second send while one is in flight", () => {
      mockSendPending = true;
      render(<ChatScreen />);
      fireEvent.changeText(screen.getByLabelText("Message Matrix"), "Ship it");
      fireEvent(screen.getByLabelText("Message Matrix"), "submitEditing");

      expect(mockSendMessage).not.toHaveBeenCalled();
      expect(screen.getByLabelText("Message Matrix").props.value).toBe("Ship it");
    });
  });
});
