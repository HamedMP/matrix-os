import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react-native";
import { KeyboardAvoidingView, StyleSheet as NativeStyleSheet } from "react-native";
import * as Clipboard from "expo-clipboard";
import { Image } from "expo-image";

import * as mockContextMenu from "./context-menu-test-utils";
import ChatScreenRoute from "../app/(drawer)/(tabs)/(chats)/index";
import { ActiveChatProvider } from "../components/chat/active-chat";
import { Icon } from "../components/ui/Icon";
import { SidePanelIcon } from "../components/ui/icons";

import { menuItem } from "./context-menu-test-utils";

// The Chats stack's layout holds the open chat's state above its screens.
const ChatScreen = () => <ActiveChatProvider><ChatScreenRoute /></ActiveChatProvider>;

jest.mock("@/lib/queries/use-bot-chat", () => ({ useBotChat: () => ({ snapshot: mockBotSnapshot, isError: false }) }));
jest.mock("@/lib/use-shell-navigation", () => ({ useOpenSidePanel: () => mockOpenSidePanel }));
jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));
// Jest resolves the iOS files, so each message sits in a native context menu.
jest.mock("@expo/ui/swift-ui", () => mockContextMenu.swiftUiContextMenuModule());

const mockSendMessage = jest.fn();
const mockOpenSidePanel = jest.fn();
let mockBotSnapshot: unknown = null;
let mockActiveChatId: string | null = null;
let mockDetail: unknown;
let mockCatalog: unknown;
let mockComputer: unknown;
let mockSendPending = false;
let mockCatalogLoading = false;
let mockInsets = { top: 0, right: 0, bottom: 0, left: 0 };

jest.mock("@clerk/clerk-expo", () => ({
  useAuth: () => ({ isSignedIn: true }),
}));

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => mockInsets,
}));

jest.mock("@/lib/canonical-chat-session-context", () => ({
  useCanonicalChatSession: () => ({
    activeChatId: mockActiveChatId,
    selectionOverride: null,
    setSelectionOverride: jest.fn(),
    selectedProjectId: null,
    setSelectedProjectId: jest.fn(),
    bindDraftChatId: jest.fn(),
    startDraftChat: jest.fn(),
    draftChatRequests: 0,
  }),
}));

jest.mock("@/lib/queries/use-canonical-chat-detail", () => ({
  useCanonicalChatDetail: () => ({ detail: mockDetail, computer: mockComputer }),
}));

jest.mock("@/lib/queries/use-chat-provider-catalog", () => ({
  useChatProviderCatalog: () => ({ catalog: mockCatalog, isPending: mockCatalogLoading, isFetching: mockCatalogLoading }),
}));

jest.mock("@/lib/queries/use-send-chat-message", () => ({
  useSendChatMessage: () => ({ mutate: mockSendMessage, isPending: mockSendPending }),
}));

jest.mock("@/lib/queries/use-retry-chat-turn", () => ({
  useRetryChatTurn: () => ({ mutate: jest.fn(), isPending: false, isError: false, variables: undefined }),
}));
jest.mock("@/lib/queries/use-cancel-run", () => ({
  useCancelRun: () => ({ mutate: jest.fn(), isPending: false }),
}));

jest.mock("@/lib/queries/use-canonical-chats", () => ({
  useCanonicalChats: () => ({ chats: [] }),
}));

jest.mock("@/lib/queries/use-computer-apps", () => ({
  useComputerApps: () => ({ apps: [] }),
  installedAppSlug: (app: { slug: string }) => app.slug,
}));

jest.mock("expo-router", () => ({ useRouter: () => ({ push: jest.fn() }) }));

beforeEach(() => jest.useFakeTimers());
afterEach(() => { act(() => jest.runOnlyPendingTimers()); cleanup(); jest.useRealTimers(); });

describe("drawer home screen", () => {
  it("expands the exact tool command and bounded result", () => {
    mockActiveChatId = "chat_tools";
    mockDetail = { record: { chat: { id: mockActiveChatId, title: "Tools" } }, turns: [],
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
    mockBotSnapshot = null;
    mockActiveChatId = null;
    mockDetail = undefined;
    mockCatalog = undefined;
    mockComputer = undefined;
    mockSendPending = false;
    mockCatalogLoading = false;
    mockInsets = { top: 0, right: 0, bottom: 0, left: 0 };
    mockSendMessage.mockReset();
    mockOpenSidePanel.mockReset();
    jest.restoreAllMocks();
  });
  it("copies the displayed Native Mobile conversation ID by long-pressing its content", () => {
    mockActiveChatId = "chat_native_content";
    mockDetail = { record: { chat: { id: mockActiveChatId, title: "Native failure" } }, runs: [], turns: [], activities: [],
      messages: [{ id: "msg_native_copy", chatId: mockActiveChatId, role: "user", state: "committed", seq: 1,
        parts: [{ type: "text", text: "Inspect native failure" }], createdAt: "2026-09-09T00:00:00.000Z" }] };
    render(<ChatScreen />);
    fireEvent.press(menuItem(screen.getByText("Inspect native failure"), "Copy chat ID"));
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith("chat_native_content");
  });

  it("greets a new chat with the Matrix mark, 40pt high, and the heading in place of a welcome by name", () => {
    render(<ChatScreen />);

    expect(screen.getByRole("header", { name: "What should we work on?" })).toBeTruthy();
    expect(screen.queryByText(/Welcome back/)).toBeNull();
    const mark = NativeStyleSheet.flatten(screen.UNSAFE_getByType(Image).props.style) as Record<string, number>;
    expect(mark.height).toBe(40);
    expect(mark.width).toBeCloseTo(30.9, 5);
  });
  it("opens the side panel from the button in its top bar", () => {
    render(<ChatScreen />);

    const button = screen.getByRole("button", { name: "Open chats and projects" });
    expect(NativeStyleSheet.flatten(button.props.style)).toMatchObject({ width: 44, height: 44 });
    expect(screen.UNSAFE_getAllByType(Icon).some((icon) => icon.props.icon === SidePanelIcon)).toBe(true);
    expect(mockOpenSidePanel).not.toHaveBeenCalled();

    fireEvent.press(button);

    expect(mockOpenSidePanel).toHaveBeenCalledTimes(1);
  });

  it("starts below the status bar and measures the keyboard from the top of the window", () => {
    mockInsets = { top: 62, right: 0, bottom: 34, left: 0 };
    render(<ChatScreen />);

    const keyboardView = screen.UNSAFE_getByType(KeyboardAvoidingView);
    expect(NativeStyleSheet.flatten(keyboardView.props.style)).toMatchObject({ flex: 1, paddingTop: 62 });
    // No header sits above the screen any more, and the tab bar is beneath it
    // rather than inside it, so there is nothing to offset the keyboard by.
    expect(keyboardView.props.keyboardVerticalOffset).toBeUndefined();
  });

  it("no longer offers bot recipes, which are on the Agents tab", () => {
    render(<ChatScreen />);

    expect(screen.queryByLabelText("Bot recipes")).toBeNull();
    expect(screen.queryByText("Bot recipes")).toBeNull();
  });

  describe("optimistic send", () => {
    const catalog = {
      instances: [{
        id: "instance_test",
        availability: "available",
        defaultSelection: { instanceId: "instance_test", model: "test" },
        models: [{ id: "test", availability: "available" }],
        options: [],
        supports: { rootChat: true, interactionModes: ["default"], permissionModes: ["supervised"], attachments: [] },
        skills: [],
        commands: [],
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
      return { record: { chat: { id: chatId, title: "Release", revision: 4 } }, runs: [], turns, activities: [], messages };
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
      expect(screen.queryByText("What should we work on?")).toBeNull();
    });

    it("sends a draft of several lines with its line breaks, trimming only the ends", () => {
      render(<ChatScreen />);
      sendDraft("\nPlan the week:\n\n- gym\n- groceries\n");

      expect(mockSendMessage.mock.calls[0][0]).toMatchObject({ text: "Plan the week:\n\n- gym\n- groceries" });
      expect(screen.getByLabelText("Message Matrix").props.value).toBe("");
    });

    it("keeps a message that failed to send where it was, marked as not sent, and gives it back on Edit", () => {
      render(<ChatScreen />);
      sendDraft("Ship it");

      act(() => { mockSendMessage.mock.calls[0][1].onError(new Error("offline")); });

      expect(screen.getByText("Ship it")).toBeTruthy();
      expect(screen.getByText("Not sent")).toBeTruthy();
      expect(screen.getByLabelText("Message Matrix").props.value).toBe("");
      expect(screen.queryByText("What should we work on?")).toBeNull();

      fireEvent.press(screen.getByRole("button", { name: "Edit message" }));
      expect(screen.queryByText("Not sent")).toBeNull();
      expect(screen.getByLabelText("Message Matrix").props.value).toBe("Ship it");
      expect(screen.getByText("What should we work on?")).toBeTruthy();
    });

    it("keeps text typed while a failed send was in flight, ahead of which Edit puts the message", () => {
      render(<ChatScreen />);
      sendDraft("Ship it");
      fireEvent.changeText(screen.getByLabelText("Message Matrix"), "and tag it");

      act(() => { mockSendMessage.mock.calls[0][1].onError(new Error("offline")); });
      expect(screen.getByLabelText("Message Matrix").props.value).toBe("and tag it");

      fireEvent.press(screen.getByRole("button", { name: "Edit message" }));
      expect(screen.getByLabelText("Message Matrix").props.value).toBe("Ship it and tag it");
    });

    it("reuses the idempotency keys when a message that was not sent is retried", () => {
      render(<ChatScreen />);
      sendDraft("Ship it");
      act(() => { mockSendMessage.mock.calls[0][1].onError(new Error("offline")); });
      fireEvent.press(screen.getByRole("button", { name: "Retry sending" }));

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

    it("shows a failed send as not sent in the chat it was sent in, not the one on screen", () => {
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
      expect(screen.queryByText("Not sent")).toBeNull();

      // Back in the original chat, the message is there, marked as not sent.
      mockActiveChatId = "chat_a";
      mockDetail = detailFor("chat_a", []);
      view.rerender(<ChatScreen />);
      expect(screen.getByText("Ship it")).toBeTruthy();
      expect(screen.getByText("Not sent")).toBeTruthy();
      expect(screen.getByLabelText("Message Matrix").props.value).toBe("");
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
      expect(screen.getByText("Not sent")).toBeTruthy();
      expect(screen.getByLabelText("Message Matrix").props.value).toBe("");

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

    it("does not send while the provider catalog is still loading", () => {
      mockCatalogLoading = true;
      render(<ChatScreen />);
      fireEvent.changeText(screen.getByLabelText("Message Matrix"), "Ship it");
      const send = screen.getByRole("button", { name: "Send message" });
      expect(send.props.accessibilityState).toMatchObject({ disabled: true });
      fireEvent.press(send);

      expect(mockSendMessage).not.toHaveBeenCalled();
      expect(screen.queryByText("Ship it")).toBeNull();
      expect(screen.getByLabelText("Message Matrix").props.value).toBe("Ship it");
    });

    it("does not start a second send while one is in flight", () => {
      mockSendPending = true;
      render(<ChatScreen />);
      fireEvent.changeText(screen.getByLabelText("Message Matrix"), "Ship it");
      // The send button is Stop until the send is answered.
      expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
      expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();

      expect(mockSendMessage).not.toHaveBeenCalled();
      expect(screen.getByLabelText("Message Matrix").props.value).toBe("Ship it");
    });
  });
});

it("sends an owner-verified Native bot Chat with its private route while the general model catalog is unavailable", () => {
  mockActiveChatId = "chat_bot";
  mockDetail = { record: { chat: { id: mockActiveChatId, title: "Writer", revision: 3 } }, runs: [], turns: [], activities: [], messages: [] };
  mockBotSnapshot = { agentId: "bot_abcdefgh", name: "Writer", revision: 2,
    selection: { instanceId: "matrix_pi_default", model: "cloudflare:@cf/zai-org/glm-5.3-flash" }, interactions: [], tasks: [],
    authority: { agentId: "bot_abcdefgh", revision: 1, grants: [], connections: [], routines: [], pendingInteractions: [], memory: { items: [] } } };
  render(<ChatScreen />);
  const input = screen.getByPlaceholderText("Reply…");
  fireEvent.changeText(input, "Write a brief");
  fireEvent(input, "focus");
  fireEvent.press(screen.getByRole("button", { name: "Send message" }));
  expect(mockSendMessage).toHaveBeenCalledWith(expect.objectContaining({ chatId: "chat_bot", baseRevision: 3,
    selection: { instanceId: "matrix_bot_default", model: "auto" }, interactionMode: "default", permissionMode: "default" }), expect.anything());
});
