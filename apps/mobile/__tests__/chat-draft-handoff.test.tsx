import type { ReactNode } from "react";
import React from "react";
import { act, cleanup, fireEvent, render, renderHook } from "@testing-library/react-native";

import ChatScreen from "../app/(drawer)/(tabs)/(chats)/index";
import {
  consumeChatDraftRequest,
  requestChatDraft,
  useChatDraftRequest,
} from "../components/agents/chat-draft-request";

jest.mock("@/lib/queries/use-bot-chat", () => ({ useBotChat: () => ({ snapshot: null, isError: false }) }));
jest.mock("@/lib/use-shell-navigation", () => ({ useOpenSidePanel: () => jest.fn() }));
jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));

const mockSendMessage = jest.fn();
let mockActiveChatId: string | null = null;
let mockDetail: unknown;

jest.mock("@clerk/clerk-expo", () => ({ useAuth: () => ({ isSignedIn: true, userId: "user_a" }) }));
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 62, right: 0, bottom: 34, left: 0 }),
}));
jest.mock("expo-router", () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock("@/lib/use-keyboard-visible", () => ({ useKeyboardVisible: () => false }));
jest.mock("@/lib/canonical-chat-session-context", () => ({
  useCanonicalChatSession: () => ({
    activeChatId: mockActiveChatId,
    startDraftChat: jest.fn(),
    draftChatRequests: 0,
    selectionOverride: null,
    setSelectionOverride: jest.fn(),
    selectedProjectId: null,
  }),
}));
jest.mock("@/lib/queries/use-canonical-chat-detail", () => ({
  useCanonicalChatDetail: () => ({
    detail: mockDetail,
    computer: { handle: "amin", runtimeSlot: "primary", gatewayPath: "/vm/amin" },
    refresh: jest.fn(),
  }),
}));
jest.mock("@/lib/queries/use-canonical-chats", () => ({ useCanonicalChats: () => ({ chats: [] }) }));
jest.mock("@/lib/queries/use-chat-provider-catalog", () => ({
  useChatProviderCatalog: () => ({ catalog: mockCatalog, isPending: false, isFetching: false }),
}));
jest.mock("@/lib/queries/use-send-chat-message", () => ({
  useSendChatMessage: () => ({ mutate: mockSendMessage, isPending: false }),
}));
jest.mock("@/lib/queries/use-cancel-run", () => ({ useCancelRun: () => ({ mutate: jest.fn(), isPending: false }) }));
jest.mock("@/lib/queries/use-computer-apps", () => ({
  useComputerApps: () => ({ apps: [] }),
  installedAppSlug: (app: { slug: string }) => app.slug,
}));
jest.mock("@expo/ui/community/menu", () => {
  const React = jest.requireActual("react") as typeof import("react");
  const { View } = jest.requireActual("react-native") as typeof import("react-native");
  return { MenuView: (props: { children?: ReactNode }) => React.createElement(View, props, props.children) };
});

const mockCatalog = {
  instances: [{
    id: "matrix_pi_default", driverKind: "matrix_pi", displayName: "Pi", connectionLabel: "Matrix AI",
    availability: "available",
    defaultSelection: { instanceId: "matrix_pi_default", model: "sonnet" },
    models: [{ id: "sonnet", displayName: "Sonnet 5", availability: "available" }],
    options: [],
    supports: { interactionModes: ["default"], permissionModes: ["supervised"] },
  }],
};

const prompt = "Help me create a Matrix agent inspired by “Account research”.";

function openChat() {
  mockActiveChatId = "chat_habits";
  mockDetail = {
    record: { projectId: null, chat: { id: "chat_habits", title: "Habit tracker app", revision: 4 } },
    runs: [], turns: [], activities: [], messages: [],
  };
}

function showNewChat() {
  mockActiveChatId = null;
  mockDetail = undefined;
}

// Rendering this probe makes it the tree `screen` looks at, so the chat screen
// is read through its own render result instead.
function pendingRequest() {
  const { result, unmount } = renderHook(() => useChatDraftRequest());
  const request = result.current;
  unmount();
  return request;
}

type ChatView = ReturnType<typeof render>;

const composerOf = (view: ChatView) => view.getByLabelText("Message Matrix");

describe("chat screen: a draft asked for by another screen", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    act(() => jest.runOnlyPendingTimers());
    cleanup();
    jest.useRealTimers();
    const leftover = pendingRequest();
    if (leftover) consumeChatDraftRequest(leftover.id);
    showNewChat();
    mockSendMessage.mockReset();
  });

  it("puts the requested text in the new chat's composer, without sending it, and takes the request", () => {
    const view = render(<ChatScreen />);
    expect(composerOf(view).props.value).toBe("");

    act(() => requestChatDraft(prompt));

    expect(composerOf(view).props.value).toBe(prompt);
    expect(view.getByRole("button", { name: "Send message" }).props.accessibilityState).toMatchObject({ disabled: false });
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(pendingRequest()).toBeNull();
  });

  it("takes a request made before the chat screen was on screen", () => {
    requestChatDraft(prompt);

    const view = render(<ChatScreen />);

    expect(composerOf(view).props.value).toBe(prompt);
    expect(pendingRequest()).toBeNull();
  });

  it("applies it once: text the person changes afterwards is left alone", () => {
    const view = render(<ChatScreen />);
    act(() => requestChatDraft(prompt));

    fireEvent.changeText(composerOf(view), "Something else");
    view.rerender(<ChatScreen />);

    expect(composerOf(view).props.value).toBe("Something else");
  });

  it("does nothing while a chat is open: its composer stays as it was and the request waits", () => {
    openChat();
    const view = render(<ChatScreen />);
    fireEvent.changeText(composerOf(view), "A reply in progress");

    act(() => requestChatDraft(prompt));

    expect(composerOf(view).props.value).toBe("A reply in progress");
    expect(pendingRequest()).toMatchObject({ text: prompt });
  });

  it("hands the waiting text to the new chat once that is the chat on screen", () => {
    openChat();
    const view = render(<ChatScreen />);
    act(() => requestChatDraft(prompt));
    expect(composerOf(view).props.value).toBe("");

    showNewChat();
    view.rerender(<ChatScreen />);

    expect(composerOf(view).props.value).toBe(prompt);
    expect(pendingRequest()).toBeNull();

    // The chat that was open did not receive it.
    openChat();
    view.rerender(<ChatScreen />);
    expect(composerOf(view).props.value).toBe("");
  });
});
