import type { ReactNode } from "react";
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react-native";
import { TextInput } from "react-native";

import ChatScreen from "../app/(drawer)/(tabs)/(chats)/index";
import { CHAT_SUGGESTIONS } from "../components/chat/chat-suggestions";
import { Icon } from "../components/ui/Icon";
import { MicIcon } from "../components/ui/icons";

import { flat } from "./ui-test-utils";

jest.mock("@/lib/queries/use-bot-chat", () => ({ useBotChat: () => ({ snapshot: mockBotSnapshot, isError: mockBotError }) }));
jest.mock("@/lib/use-shell-navigation", () => ({ useOpenSidePanel: () => jest.fn() }));
jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));

const mockSendMessage = jest.fn();
const mockCancelRun = jest.fn();
const mockStartDraftChat = jest.fn();
const mockPush = jest.fn();
let mockBotSnapshot: unknown = null;
let mockBotError = false;
let mockSignedIn = true;
let mockActiveChatId: string | null = null;
let mockDraftChatRequests = 0;
let mockDetail: unknown;
let mockChats: unknown[] = [];
let mockApps: unknown[] = [];
let mockSendPending = false;
let mockCancelPending = false;
let mockKeyboardVisible = false;
const mockInsets = { top: 62, right: 0, bottom: 34, left: 0 };

jest.mock("@clerk/clerk-expo", () => ({ useAuth: () => ({ isSignedIn: mockSignedIn, userId: "user_a" }) }));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => mockInsets }));
jest.mock("expo-router", () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock("@/lib/use-keyboard-visible", () => ({ useKeyboardVisible: () => mockKeyboardVisible }));
jest.mock("@/lib/canonical-chat-session-context", () => ({
  useCanonicalChatSession: () => ({
    activeChatId: mockActiveChatId,
    startDraftChat: mockStartDraftChat,
    draftChatRequests: mockDraftChatRequests,
    selectionOverride: null,
    setSelectionOverride: jest.fn(),
    selectedProjectId: null,
    setSelectedProjectId: jest.fn(),
    bindDraftChatId: jest.fn(),
  }),
}));
jest.mock("@/lib/queries/use-canonical-chat-detail", () => ({
  useCanonicalChatDetail: () => ({
    detail: mockDetail,
    computer: { handle: "amin", runtimeSlot: "primary", gatewayPath: "/vm/amin" },
    refresh: jest.fn(),
  }),
}));
jest.mock("@/lib/queries/use-canonical-chats", () => ({ useCanonicalChats: () => ({ chats: mockChats }) }));
jest.mock("@/lib/queries/use-chat-provider-catalog", () => ({
  useChatProviderCatalog: () => ({ catalog: mockCatalog, isPending: false, isFetching: false }),
}));
jest.mock("@/lib/queries/use-send-chat-message", () => ({
  useSendChatMessage: () => ({ mutate: mockSendMessage, isPending: mockSendPending }),
}));
jest.mock("@/lib/queries/use-cancel-run", () => ({
  useCancelRun: () => ({ mutate: mockCancelRun, isPending: mockCancelPending }),
}));
jest.mock("@/lib/queries/use-computer-apps", () => ({
  useComputerApps: () => ({ apps: mockApps }),
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
    options: [{ id: "effort", label: "Effort", kind: "enum", placement: "composer", defaultValue: "medium",
      values: [{ value: "low", label: "Low" }, { value: "medium", label: "Medium" }] }],
    supports: { interactionModes: ["default"], permissionModes: ["supervised"] },
  }],
};

function chatDetail(overrides: Record<string, unknown> = {}) {
  return {
    record: { projectId: null, chat: { id: "chat_habits", title: "Habit tracker app", revision: 4 } },
    runs: [], turns: [], activities: [], messages: [],
    ...overrides,
  };
}

function reply(text: string) {
  return { id: "msg_reply", chatId: "chat_habits", role: "assistant", state: "committed", seq: 2, runId: "run_done",
    parts: [{ type: "text", text }], createdAt: "2026-09-09T00:00:01.000Z" };
}

const finishedRun = { id: "run_done", turnId: "cturn_1", status: "completed", selection: { model: "sonnet" },
  createdAt: "2026-09-09T00:00:00.000Z", startedAt: "2026-09-09T00:00:00.000Z", completedAt: "2026-09-09T00:00:04.000Z" };
const runningRun = { id: "run_live", turnId: "cturn_2", status: "running", selection: { model: "sonnet" },
  createdAt: "2026-09-09T00:01:00.000Z", startedAt: "2026-09-09T00:01:00.000Z" };

function openChat(overrides: Record<string, unknown> = {}) {
  mockActiveChatId = "chat_habits";
  mockDetail = chatDetail(overrides);
}

const focus = TextInput.prototype.focus as jest.Mock;

beforeEach(() => {
  jest.useFakeTimers();
  focus.mockClear();
});
afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  cleanup();
  jest.useRealTimers();
  mockBotSnapshot = null;
  mockBotError = false;
  mockSignedIn = true;
  mockActiveChatId = null;
  mockDraftChatRequests = 0;
  mockDetail = undefined;
  mockChats = [];
  mockApps = [];
  mockSendPending = false;
  mockCancelPending = false;
  mockKeyboardVisible = false;
  mockSendMessage.mockReset();
  mockCancelRun.mockReset();
  mockStartDraftChat.mockReset();
  mockPush.mockReset();
});

describe("chat screen: new chat", () => {
  it("opens on New chat with the greeting and suggestions, the keyboard closed", () => {
    render(<ChatScreen />);
    act(() => jest.runOnlyPendingTimers());

    expect(screen.getByRole("header", { name: "New chat" })).toBeTruthy();
    expect(screen.getByRole("header", { name: "What should we work on?" })).toBeTruthy();
    expect(screen.queryByText(/Welcome back/)).toBeNull();
    expect(screen.getByPlaceholderText("Ask anything")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "New chat" })).toBeNull();
    expect(focus).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Message Matrix").props.autoFocus).toBeFalsy();
  });

  it("puts a tapped suggestion in the composer with the cursor after it, as web and desktop do, without sending", () => {
    render(<ChatScreen />);

    fireEvent.press(screen.getByRole("button", { name: CHAT_SUGGESTIONS[0] }));

    expect(screen.getByLabelText("Message Matrix").props.value).toBe("Build an app that tracks my habits");
    expect(focus).toHaveBeenCalledTimes(1);
    expect(mockSendMessage).not.toHaveBeenCalled();
    // Still a new chat: the suggestions stay until something is sent.
    expect(screen.getByRole("header", { name: "What should we work on?" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send message" }).props.accessibilityState).toMatchObject({ disabled: false });
  });

  it("puts the cursor in the composer when the person asks for a new chat, from the side panel or the top bar", () => {
    const view = render(<ChatScreen />);
    act(() => jest.runOnlyPendingTimers());
    expect(focus).not.toHaveBeenCalled();

    mockDraftChatRequests = 1;
    view.rerender(<ChatScreen />);
    // Not at once: the side panel puts the keyboard away as it starts to close.
    expect(focus).not.toHaveBeenCalled();
    act(() => jest.runOnlyPendingTimers());

    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("does not take the cursor when a chat is opened or left without asking for a new one", () => {
    const view = render(<ChatScreen />);
    openChat();
    view.rerender(<ChatScreen />);
    mockActiveChatId = null;
    mockDetail = undefined;
    view.rerender(<ChatScreen />);
    act(() => jest.runOnlyPendingTimers());

    expect(focus).not.toHaveBeenCalled();
  });

  it("says it is signing in, and cannot be typed in, while nobody is signed in", () => {
    mockSignedIn = false;
    render(<ChatScreen />);

    expect(screen.getByPlaceholderText("Signing in…").props.editable).toBe(false);
  });

  it("offers no project picker, no reasoning-effort choice and no microphone", () => {
    render(<ChatScreen />);
    fireEvent(screen.getByLabelText("Message Matrix"), "focus");

    expect(screen.queryByLabelText("Project")).toBeNull();
    expect(screen.queryByTestId("project-picker")).toBeNull();
    expect(screen.queryByTestId("model-option-picker")).toBeNull();
    expect(screen.queryByLabelText("Effort")).toBeNull();
    expect(screen.UNSAFE_queryAllByType(Icon).some((icon) => icon.props.icon === MicIcon)).toBe(false);
  });

  it("shows the engine and model on the trigger whether or not the composer is focused", () => {
    render(<ChatScreen />);

    expect(screen.getByText("Matrix AI · Sonnet 5")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Attach" })).toBeTruthy();
  });

  it("sends a new chat with no project and the catalog's default modes", () => {
    render(<ChatScreen />);
    fireEvent.changeText(screen.getByLabelText("Message Matrix"), "Ship it");
    fireEvent.press(screen.getByRole("button", { name: "Send message" }));

    expect(mockSendMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatId: null, text: "Ship it", projectId: null,
      selection: { instanceId: "matrix_pi_default", model: "sonnet" },
      interactionMode: "default", permissionMode: "supervised",
    }), expect.anything());
  });

  it("leaves the bottom inset to the tab bar and sits 10pt above it, or 8pt above the keyboard", () => {
    const view = render(<ChatScreen />);
    expect(flat(screen.getByTestId("composer")).paddingBottom).toBe(10);

    mockKeyboardVisible = true;
    view.rerender(<ChatScreen />);
    expect(flat(screen.getByTestId("composer")).paddingBottom).toBe(8);
  });
});

describe("chat screen: open chat", () => {
  it("titles the top bar with the chat, invites a reply, and offers New chat", () => {
    openChat();
    render(<ChatScreen />);

    expect(screen.getByRole("header", { name: "Habit tracker app" })).toBeTruthy();
    expect(screen.getByPlaceholderText("Reply…")).toBeTruthy();
    expect(screen.queryByText("What should we work on?")).toBeNull();

    fireEvent.press(screen.getByRole("button", { name: "New chat" }));

    expect(mockStartDraftChat).toHaveBeenCalledTimes(1);
    expect(mockStartDraftChat).toHaveBeenCalledWith();
  });

  it("takes the title from the chat list while the chat itself is still loading", () => {
    mockActiveChatId = "chat_habits";
    mockChats = [{ chat: { id: "chat_habits", title: "Habit tracker app" } }];
    render(<ChatScreen />);

    expect(screen.getByRole("header", { name: "Habit tracker app" })).toBeTruthy();
  });

  it("does not show the greeting in a chat that has no messages yet", () => {
    openChat();
    render(<ChatScreen />);

    expect(screen.queryByRole("button", { name: CHAT_SUGGESTIONS[0] })).toBeNull();
  });

  it("turns send into stop while a turn runs, and stop cancels that run", () => {
    openChat({ runs: [finishedRun, runningRun] });
    render(<ChatScreen />);

    expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
    fireEvent.press(screen.getByRole("button", { name: "Stop" }));

    expect(mockCancelRun).toHaveBeenCalledTimes(1);
    expect(mockCancelRun).toHaveBeenCalledWith({ chatId: "chat_habits", runId: "run_live" });
  });

  it("keeps the stop button while the turn keeps running, whatever became of the request to stop it", () => {
    openChat({ runs: [runningRun] });
    const view = render(<ChatScreen />);
    fireEvent.press(screen.getByRole("button", { name: "Stop" }));

    // The request is in flight: a second tap does not send a second one.
    mockCancelPending = true;
    view.rerender(<ChatScreen />);
    fireEvent.press(screen.getByRole("button", { name: "Stop" }));
    expect(mockCancelRun).toHaveBeenCalledTimes(1);

    // It failed; the run is still going.
    mockCancelPending = false;
    view.rerender(<ChatScreen />);
    expect(screen.getByRole("button", { name: "Stop" }).props.accessibilityState).toMatchObject({ disabled: false });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("goes back to send once the run has finished", () => {
    openChat({ runs: [runningRun] });
    const view = render(<ChatScreen />);
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();

    mockDetail = chatDetail({ runs: [{ ...runningRun, status: "aborted" }] });
    view.rerender(<ChatScreen />);

    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.getByRole("button", { name: "Send message" })).toBeTruthy();
  });

  it("shows stop, with nothing to stop yet, while a message is on its way", () => {
    openChat();
    mockSendPending = true;
    render(<ChatScreen />);

    const stop = screen.getByRole("button", { name: "Stop" });
    expect(stop.props.accessibilityState).toMatchObject({ disabled: true });
    fireEvent.press(stop);
    expect(mockCancelRun).not.toHaveBeenCalled();
  });

  it("shows a result card under a reply that refers to an app on the computer, and Open opens its preview", () => {
    mockApps = [{ name: "Habit tracker", slug: "habit-tracker", category: "productivity",
      file: "apps/habit-tracker/index.html", path: "apps/habit-tracker/index.html" }];
    openChat({ runs: [finishedRun], messages: [reply("Done. I saved it to `apps/habit-tracker`.")] });
    render(<ChatScreen />);

    expect(screen.getByText("Habit tracker")).toBeTruthy();
    expect(screen.getByText("App · Productivity")).toBeTruthy();
    fireEvent.press(screen.getByRole("button", { name: "Open Habit tracker" }));

    expect(mockPush).toHaveBeenCalledWith({
      pathname: "/app-preview/[app]",
      params: { app: "habit-tracker", name: "Habit tracker" },
    });
  });

  it("shows no result card when a reply's reference is not an app in the catalog", () => {
    mockApps = [{ name: "Notes", slug: "notes", file: "apps/notes/index.html", path: "apps/notes/index.html" }];
    openChat({ runs: [finishedRun], messages: [reply("Done. I saved it to `apps/habit-tracker`.")] });
    render(<ChatScreen />);

    expect(screen.queryByTestId("result-card")).toBeNull();
  });

  it("does not take a bare relative path for an app in a project's chat", () => {
    mockApps = [{ name: "Habit tracker", slug: "habit-tracker",
      file: "apps/habit-tracker/index.html", path: "apps/habit-tracker/index.html" }];
    openChat({
      record: { projectId: "project_a", chat: { id: "chat_habits", title: "Habit tracker app", revision: 4 } },
      runs: [finishedRun], messages: [reply("Done. I saved it to `apps/habit-tracker`.")],
    });
    render(<ChatScreen />);

    expect(screen.queryByTestId("result-card")).toBeNull();
  });
});

// An agent's chat belongs to the Agents tab. One can still become the open
// chat here, as from a side panel row: it is then an ordinary conversation.
describe("chat screen: an agent's chat", () => {
  const pendingApproval = {
    interactionId: "in_abcdefgh", chatId: "chat_habits", agentId: "bot_abcdefgh", taskId: "task_abcdefgh",
    kind: "approval", blocking: true, status: "pending", expiresAt: "2099-01-01T00:00:00.000Z", revision: 3,
    payload: { kind: "approval", tool: "integration.call", argsDigest: "a".repeat(64),
      account: { service: "slack", label: "Work" }, audience: "direct", preview: "Post the brief", policyRevision: 1 },
  };

  function openAgentChat(overrides: Record<string, unknown> = {}) {
    openChat({ runs: [finishedRun], messages: [reply("Brief ready for your call.")] });
    mockBotSnapshot = {
      agentId: "bot_abcdefgh", name: "Writer", revision: 2, interactions: [pendingApproval],
      tasks: [{ taskId: "task_abcdefgh", chatId: "chat_habits", agentId: "bot_abcdefgh", status: "waiting_person",
        revision: 1, updatedAt: "2026-09-28T12:00:00.000Z" }],
      authority: { agentId: "bot_abcdefgh", revision: 1,
        grants: [{ grantId: "gr_abcdefgh", service: "gmail", accountLabel: "Work", effects: ["read"], audience: "direct", expiresAt: null }],
        connections: [{ service: "gmail", state: "granted" }], routines: [], pendingInteractions: [],
        memory: { items: [] } },
      ...overrides,
    };
  }

  it("shows the conversation without any of the agent's controls", () => {
    openAgentChat();
    render(<ChatScreen />);

    expect(screen.getByText("Brief ready for your call.")).toBeTruthy();
    for (const text of [
      "Writer", "Your bot's Chat", "Access & memory", "Bot model", "Needs your approval", "Approval requested",
      "Waiting for your answer", "Post the brief",
    ]) {
      expect(screen.queryByText(text)).toBeNull();
    }
    for (const label of ["Allow once", "Approve", "Deny", "Revoke Work", "Agent details"]) {
      expect(screen.queryByRole("button", { name: label })).toBeNull();
    }
  });

  it("shows the model as fixed, with nothing to pick", () => {
    openAgentChat();
    render(<ChatScreen />);

    expect(screen.getByText("Agent model")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Model" })).toBeNull();
  });

  it("still sends, on the computer's agent route", () => {
    openAgentChat();
    render(<ChatScreen />);
    fireEvent.changeText(screen.getByLabelText("Message Matrix"), "Who is next?");

    fireEvent.press(screen.getByRole("button", { name: "Send message" }));

    expect(mockSendMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatId: "chat_habits", text: "Who is next?",
      selection: { instanceId: "matrix_bot_default", model: "auto" },
      interactionMode: "default", permissionMode: "default",
    }), expect.anything());
  });

  it("says nothing about the agent's status, which is no longer shown here, when it cannot be read", () => {
    openAgentChat();
    mockBotError = true;
    render(<ChatScreen />);

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Agent model")).toBeTruthy();
  });
});
