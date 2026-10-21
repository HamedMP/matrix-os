import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react-native";
import { TextInput } from "react-native";

import ChatScreenRoute from "../app/(drawer)/(tabs)/(chats)/index";
import { ActiveChatProvider } from "../components/chat/active-chat";
import { ActiveChatScreen } from "../components/chat/ActiveChatScreen";
import { CHAT_SUGGESTIONS } from "../components/chat/chat-suggestions";
import { Icon } from "../components/ui/Icon";
import { MicIcon } from "../components/ui/icons";

import { flat } from "./ui-test-utils";

// The Chats stack's layout holds the open chat's state above its screens.
const ChatScreen = () => <ActiveChatProvider><ChatScreenRoute /></ActiveChatProvider>;

jest.mock("@/lib/queries/use-bot-chat", () => ({ useBotChat: () => ({ snapshot: mockBotSnapshot, isError: mockBotError }) }));
jest.mock("@/lib/use-shell-navigation", () => ({ useOpenSidePanel: () => jest.fn() }));
jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));

const mockSendMessage = jest.fn();
const mockPickPhotos = jest.fn();
const mockCancelRun = jest.fn();
const mockRetryTurn = jest.fn();
const mockReloadChat = jest.fn();
let mockRetryPending = false;
let mockRetryFailed = false;
let mockRetried: unknown;
let mockChatReadFailed = false;
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
    isError: mockChatReadFailed,
    reload: mockReloadChat,
  }),
}));
jest.mock("@/lib/queries/use-canonical-chats", () => ({ useCanonicalChats: () => ({ chats: mockChats }) }));
jest.mock("@/lib/queries/use-chat-provider-catalog", () => ({
  useChatProviderCatalog: () => ({ catalog: mockCatalog, isPending: false, isFetching: false }),
}));
jest.mock("@/lib/queries/use-send-chat-message", () => ({
  useSendChatMessage: () => ({ mutate: mockSendMessage, isPending: mockSendPending }),
}));
// As the native sheet does while it slides away, this one keeps its content
// when it is not presented.
jest.mock("@expo/ui", () => {
  const { View } = jest.requireActual("react-native") as typeof import("react-native");
  return {
    BottomSheet: ({ children }: { children: React.ReactNode }) => <View testID="expo-bottom-sheet">{children}</View>,
    RNHostView: ({ children }: { children: React.ReactNode }) => children,
  };
});
jest.mock("@/lib/chat-attachment-picker", () => ({
  pickPhotos: (...args: unknown[]) => mockPickPhotos(...args),
  pickFiles: jest.fn(),
}));
jest.mock("@/lib/queries/use-retry-chat-turn", () => ({
  useRetryChatTurn: () => ({
    mutate: mockRetryTurn, isPending: mockRetryPending, isError: mockRetryFailed, variables: mockRetried,
  }),
}));
jest.mock("@/lib/queries/use-cancel-run", () => ({
  useCancelRun: () => ({ mutate: mockCancelRun, isPending: mockCancelPending }),
}));
jest.mock("@/lib/queries/use-computer-apps", () => ({
  useComputerApps: () => ({ apps: mockApps }),
  installedAppSlug: (app: { slug: string }) => app.slug,
}));

const mockCatalog = {
  instances: [{
    id: "matrix_pi_default", driverKind: "matrix_pi", displayName: "Pi", connectionLabel: "Matrix AI",
    availability: "available",
    defaultSelection: { instanceId: "matrix_pi_default", model: "sonnet" },
    models: [{ id: "sonnet", displayName: "Sonnet 5", availability: "available" }],
    options: [{ id: "effort", label: "Effort", kind: "enum", placement: "composer", defaultValue: "medium",
      values: [{ value: "low", label: "Low" }, { value: "medium", label: "Medium" }] }],
    supports: { rootChat: true, interactionModes: ["default"], permissionModes: ["supervised"], attachments: [] as string[] },
    skills: [] as { id: string; displayName: string; description: string; invocation: string }[],
    commands: [],
  }],
};

const flowers = {
  id: "att_f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1", uri: "file:///cache/flowers.jpg", name: "flowers.jpg", mimeType: "image/jpeg", kind: "image", sizeBytes: 2_048,
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
  mockPickPhotos.mockReset();
  mockCatalog.instances[0]!.supports.attachments = [];
  mockCatalog.instances[0]!.skills = [];
  mockCancelRun.mockReset();
  mockStartDraftChat.mockReset();
  mockPush.mockReset();
  mockRetryTurn.mockReset();
  mockReloadChat.mockReset();
  mockRetryPending = false;
  mockRetryFailed = false;
  mockRetried = undefined;
  mockChatReadFailed = false;
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
    expect(screen.getByRole("button", { name: "Add to message" })).toBeTruthy();
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

  it("offers photos and files only when the selected model reads them", () => {
    const view = render(<ChatScreen />);
    fireEvent.press(screen.getByRole("button", { name: "Add to message" }));
    expect(screen.getByRole("button", { name: "Photos, The selected model cannot read photos" })).toBeTruthy();

    mockCatalog.instances[0]!.supports.attachments = ["file", "image"];
    view.rerender(<ChatScreen />);
    expect(screen.getByRole("button", { name: "Photos, Choose from your library" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Files, Browse the files on this phone" })).toBeTruthy();
  });

  it("shows a chosen photo in the composer and sends it, with or without text", async () => {
    mockCatalog.instances[0]!.supports.attachments = ["file", "image"];
    mockPickPhotos.mockResolvedValue({ attachments: [flowers], rejections: [] });
    render(<ChatScreen />);
    expect(screen.getByRole("button", { name: "Send message" }).props.accessibilityState).toMatchObject({ disabled: true });

    fireEvent.press(screen.getByRole("button", { name: "Add to message" }));
    await act(async () => { fireEvent.press(screen.getByRole("button", { name: "Photos, Choose from your library" })); });

    expect(screen.getByLabelText("flowers.jpg")).toBeTruthy();
    // A photo is enough to send.
    fireEvent.press(screen.getByRole("button", { name: "Send message" }));
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: null, text: "", attachments: [flowers] }),
      expect.anything(),
    );
  });

  it("turns Send off and says why once the model is changed to one that does not read a waiting photo", async () => {
    mockCatalog.instances[0]!.supports.attachments = ["file", "image"];
    mockPickPhotos.mockResolvedValue({ attachments: [flowers], rejections: [] });
    const view = render(<ChatScreen />);
    fireEvent.press(screen.getByRole("button", { name: "Add to message" }));
    await act(async () => { fireEvent.press(screen.getByRole("button", { name: "Photos, Choose from your library" })); });
    expect(screen.queryByTestId("composer-attachment-notice")).toBeNull();
    expect(screen.getByRole("button", { name: "Send message" }).props.accessibilityState).toMatchObject({ disabled: false });

    mockCatalog.instances[0]!.supports.attachments = ["file"];
    view.rerender(<ChatScreen />);

    expect(screen.getByTestId("composer-attachment-notice").props.children)
      .toBe("The selected model cannot read photos. Remove it or choose another model.");
    expect(screen.getByRole("button", { name: "Send message" }).props.accessibilityState).toMatchObject({ disabled: true });
    fireEvent.press(screen.getByRole("button", { name: "Send message" }));
    expect(mockSendMessage).not.toHaveBeenCalled();

    fireEvent.press(screen.getByRole("button", { name: "Remove flowers.jpg" }));
    expect(screen.queryByTestId("composer-attachment-notice")).toBeNull();
  });

  it("keeps a path at the start of the draft when a skill is chosen", () => {
    mockCatalog.instances[0]!.skills = [
      { id: "review", displayName: "Review", description: "Reviews the changes", invocation: "/review" },
    ];
    render(<ChatScreen />);
    fireEvent.changeText(screen.getByLabelText("Message Matrix"), "/tmp contains the logs");

    fireEvent.press(screen.getByRole("button", { name: "Add to message" }));
    fireEvent.press(screen.getByRole("button", { name: "Skills and commands, 1 for the selected model" }));
    fireEvent.press(screen.getByRole("button", { name: "/review, Reviews the changes" }));

    expect(screen.getByLabelText("Message Matrix").props.value).toBe("/review /tmp contains the logs");
  });

  it("takes a waiting photo back out", async () => {
    mockCatalog.instances[0]!.supports.attachments = ["image"];
    mockPickPhotos.mockResolvedValue({ attachments: [flowers], rejections: [] });
    render(<ChatScreen />);
    fireEvent.press(screen.getByRole("button", { name: "Add to message" }));
    await act(async () => { fireEvent.press(screen.getByRole("button", { name: "Photos, Choose from your library" })); });

    fireEvent.press(screen.getByRole("button", { name: "Remove flowers.jpg" }));

    expect(screen.queryByLabelText("flowers.jpg")).toBeNull();
    expect(screen.getByRole("button", { name: "Send message" }).props.accessibilityState).toMatchObject({ disabled: true });
  });

  it("puts a chosen skill at the start of what is being written", () => {
    mockCatalog.instances[0]!.skills = [
      { id: "review", displayName: "Review", description: "Reviews the changes", invocation: "/review" },
    ];
    render(<ChatScreen />);
    fireEvent.changeText(screen.getByLabelText("Message Matrix"), "the login screen");

    fireEvent.press(screen.getByRole("button", { name: "Add to message" }));
    fireEvent.press(screen.getByRole("button", { name: "Skills and commands, 1 for the selected model" }));
    fireEvent.press(screen.getByRole("button", { name: "/review, Reviews the changes" }));

    expect(screen.getByLabelText("Message Matrix").props.value).toBe("/review the login screen");
  });

  it("leaves the bottom inset to the tab bar and sits 10pt above it, or 8pt above the keyboard", () => {
    const view = render(<ChatScreen />);
    expect(flat(screen.getByTestId("composer")).paddingBottom).toBe(10);

    mockKeyboardVisible = true;
    view.rerender(<ChatScreen />);
    expect(flat(screen.getByTestId("composer")).paddingBottom).toBe(8);
  });
});

describe("chat screen: chat opened from a project", () => {
  const projectChat = (handlers: { onBack?: () => void; onNewChat?: () => void } = {}) => (
    <ActiveChatScreen onBack={handlers.onBack ?? jest.fn()} onNewChat={handlers.onNewChat ?? jest.fn()} />
  );

  it("goes back to the project in place of opening the side panel, and starts new chats there", () => {
    openChat();
    const onBack = jest.fn();
    const onNewChat = jest.fn();
    render(<ActiveChatProvider>{projectChat({ onBack, onNewChat })}</ActiveChatProvider>);

    expect(screen.getByRole("header", { name: "Habit tracker app" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open chats and projects" })).toBeNull();

    fireEvent.press(screen.getByRole("button", { name: "Back" }));
    expect(onBack).toHaveBeenCalledTimes(1);

    fireEvent.press(screen.getByRole("button", { name: "New chat" }));
    expect(onNewChat).toHaveBeenCalledTimes(1);
    expect(mockStartDraftChat).not.toHaveBeenCalled();
  });

  it("keeps a half-typed reply and a message that was not sent once it has gone back and is opened again", () => {
    openChat();
    const view = render(<ActiveChatProvider>{projectChat()}</ActiveChatProvider>);
    fireEvent.changeText(screen.getByLabelText("Message Matrix"), "Ship it");
    fireEvent.press(screen.getByRole("button", { name: "Send message" }));
    const options = mockSendMessage.mock.calls.at(-1)![1] as { onError: (error: Error) => void };
    act(() => options.onError(new Error("Could not send message. Try again.")));
    fireEvent.changeText(screen.getByLabelText("Message Matrix"), "Half a reply");

    // Back leaves the project's chat; the Chats stack, and what it holds, stays.
    view.rerender(<ActiveChatProvider>{null}</ActiveChatProvider>);
    expect(screen.queryByLabelText("Message Matrix")).toBeNull();
    view.rerender(<ActiveChatProvider>{projectChat()}</ActiveChatProvider>);

    expect(screen.getByLabelText("Message Matrix").props.value).toBe("Half a reply");
    expect(screen.getByText("Ship it")).toBeTruthy();
    expect(screen.getByRole("alert", { name: "Not sent" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry sending" })).toBeTruthy();
  });

  it("shares one composer with the Chats tab's own chat screen beneath it", () => {
    openChat();
    render(<ActiveChatProvider><ChatScreenRoute />{projectChat()}</ActiveChatProvider>);
    const [beneath, onTop] = screen.getAllByLabelText("Message Matrix");

    fireEvent.changeText(onTop, "Half a reply");

    expect(beneath.props.value).toBe("Half a reply");
  });

  it("leaves new-chat requests to the Chats tab's own chat screen", () => {
    openChat();
    const view = render(<ActiveChatProvider>{projectChat()}</ActiveChatProvider>);

    mockDraftChatRequests = 1;
    view.rerender(<ActiveChatProvider>{projectChat()}</ActiveChatProvider>);
    act(() => jest.runOnlyPendingTimers());

    expect(focus).not.toHaveBeenCalled();
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
      params: { app: "habit-tracker", runtimeSlug: "habit-tracker", name: "Habit tracker" },
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

describe("chat screen: recovering from failures", () => {
  const at = "2026-09-09T00:00:00.000Z";
  const prompt = { id: "msg_1", chatId: "chat_habits", role: "user", state: "committed", seq: 1,
    parts: [{ type: "text", text: "Build the habit tracker" }], createdAt: at };
  const turn = { id: "cturn_1", chatId: "chat_habits", clientRequestId: "req_first", inputMessageId: "msg_1",
    baseMessageSeq: 0, status: "failed", createdAt: at, updatedAt: at };
  const failedRun = { id: "run_failed", chatId: "chat_habits", turnId: "cturn_1", attempt: 1, status: "failed",
    selection: { model: "sonnet" }, createdAt: at, updatedAt: at, startedAt: at, completedAt: at };
  const connectionLost = { id: "act_error", type: "run.error", runId: "run_failed", sequence: 3, occurredAt: at,
    error: { code: "service_unavailable", safeMessage: "Connection lost. Reconnect or try again.", retryable: true,
      recoveryActions: ["retry"] } };

  function typeAndSend(text: string) {
    fireEvent.changeText(screen.getByLabelText("Message Matrix"), text);
    fireEvent.press(screen.getByRole("button", { name: "Send message" }));
  }

  /** Settles the latest send as the mutation would. */
  function failLatestSend() {
    const options = mockSendMessage.mock.calls.at(-1)![1] as { onError: (error: Error) => void };
    act(() => options.onError(new Error("Could not send message. Try again.")));
  }

  it("shows the chat loading until it has been read, and sends nothing to it meanwhile", () => {
    mockActiveChatId = "chat_habits";
    mockDetail = null;
    mockChats = [{ chat: { id: "chat_habits", title: "Habit tracker app" } }];
    render(<ChatScreen />);

    expect(screen.getByLabelText("Loading chat")).toBeTruthy();
    expect(screen.getByRole("header", { name: "Habit tracker app" })).toBeTruthy();
    fireEvent.changeText(screen.getByLabelText("Message Matrix"), "Ship it");
    const send = screen.getByRole("button", { name: "Send message" });
    expect(send.props.accessibilityState).toMatchObject({ disabled: true });
    fireEvent.press(send);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("says a chat that could not be read is unavailable, and reads it again on request", () => {
    mockActiveChatId = "chat_habits";
    mockDetail = null;
    mockChatReadFailed = true;
    const view = render(<ChatScreen />);

    expect(screen.getByRole("alert", { name: "Chat unavailable" })).toBeTruthy();
    fireEvent.press(screen.getByRole("button", { name: "Try again" }));
    expect(mockReloadChat).toHaveBeenCalledTimes(1);

    // Read again, the chat is loading once more until it answers.
    mockChatReadFailed = false;
    view.rerender(<ChatScreen />);
    expect(screen.getByLabelText("Loading chat")).toBeTruthy();
  });

  it("keeps a message that could not be sent in the chat, sends it again as the same send, or takes it back to edit", () => {
    openChat();
    render(<ChatScreen />);
    typeAndSend("Ship it");
    failLatestSend();

    expect(screen.getByText("Ship it")).toBeTruthy();
    expect(screen.getByRole("alert", { name: "Not sent" })).toBeTruthy();
    expect(screen.getByLabelText("Message Matrix").props.value).toBe("");

    fireEvent.press(screen.getByRole("button", { name: "Retry sending" }));
    expect(mockSendMessage).toHaveBeenCalledTimes(2);
    const [first, second] = mockSendMessage.mock.calls.map((call) => call[0] as { turnRequestId: string; text: string });
    expect(second).toMatchObject({ chatId: "chat_habits", text: "Ship it", turnRequestId: first!.turnRequestId });
    expect(screen.queryByText("Not sent")).toBeNull();

    failLatestSend();
    fireEvent.press(screen.getByRole("button", { name: "Edit message" }));
    expect(screen.queryByText("Not sent")).toBeNull();
    expect(screen.getByLabelText("Message Matrix").props.value).toBe("Ship it");
  });

  it("holds the Retry of a message that was not sent while a run is active", () => {
    openChat();
    const view = render(<ChatScreen />);
    typeAndSend("Ship it");
    failLatestSend();

    mockDetail = chatDetail({ runs: [runningRun] });
    view.rerender(<ChatScreen />);
    const retry = screen.getByRole("button", { name: "Retry sending" });
    expect(retry.props.accessibilityState).toMatchObject({ disabled: true });
    fireEvent.press(retry);
    expect(mockSendMessage).toHaveBeenCalledTimes(1);

    // Once the run is over, it can be sent again.
    mockDetail = chatDetail({ runs: [finishedRun] });
    view.rerender(<ChatScreen />);
    fireEvent.press(screen.getByRole("button", { name: "Retry sending" }));
    expect(mockSendMessage).toHaveBeenCalledTimes(2);
  });

  it("offers to run a failed turn again, at the chat's revision, as the same retry when pressed again", () => {
    openChat({ messages: [prompt], turns: [turn], runs: [failedRun], activities: [connectionLost] });
    render(<ChatScreen />);

    expect(screen.getByText("Agent work failed")).toBeTruthy();
    expect(screen.getByText("Connection lost. Reconnect or try again.")).toBeTruthy();
    fireEvent.press(screen.getByRole("button", { name: "Retry" }));
    fireEvent.press(screen.getByRole("button", { name: "Retry" }));

    expect(mockRetryTurn).toHaveBeenCalledTimes(2);
    const [first, second] = mockRetryTurn.mock.calls.map((call) => call[0]);
    expect(first).toMatchObject({ chatId: "chat_habits", turnId: "cturn_1", baseRevision: 4 });
    expect(first.clientRequestId).toMatch(/^req_/);
    expect(second.clientRequestId).toBe(first.clientRequestId);
  });

  it("says when a retry did not go through", () => {
    openChat({ messages: [prompt], turns: [turn], runs: [failedRun], activities: [connectionLost] });
    mockRetryFailed = true;
    mockRetried = { chatId: "chat_habits", turnId: "cturn_1" };
    render(<ChatScreen />);

    expect(screen.getByRole("alert", { name: "Could not retry. Try again." })).toBeTruthy();
  });

  it("keeps Retry off while a message is on its way", () => {
    openChat({ messages: [prompt], turns: [turn], runs: [failedRun], activities: [connectionLost] });
    render(<ChatScreen />);
    typeAndSend("Try something else");

    expect(screen.getByRole("button", { name: "Retry" }).props.accessibilityState).toMatchObject({ disabled: true });
  });

  it("does not offer Retry for a failure a retry does not help", () => {
    const modelGone = { ...connectionLost, error: { code: "model_unavailable", safeMessage: "Model unavailable. Choose another model.",
      retryable: false, recoveryActions: ["select_provider"] } };
    openChat({ messages: [prompt], turns: [turn], runs: [failedRun], activities: [modelGone] });
    render(<ChatScreen />);

    expect(screen.getByText("Model unavailable. Choose another model.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});
