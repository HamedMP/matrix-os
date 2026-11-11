// jest.mock calls are hoisted above these imports; the factories read the
// mock* values below only when the component runs.
import { act, render, waitFor } from "@testing-library/react-native";
import * as Notifications from "expo-notifications";

import { NotificationRouter } from "../components/NotificationRouter";

const mockNavigation = { name: "root navigation" };
const mockRouter = { name: "router" };
let mockSegments: string[] = [];
let mockSearchParams: Record<string, string> = {};
jest.mock("expo-router", () => ({
  useNavigationContainerRef: () => mockNavigation,
  useRouter: () => mockRouter,
  useSegments: () => mockSegments,
  useGlobalSearchParams: () => mockSearchParams,
}));

const mockShowChatScreen = jest.fn();
const mockShowChatList = jest.fn();
const mockOpenTerminal = jest.fn();
jest.mock("@/lib/notification-navigation", () => ({
  showChatScreenFromRoot: (...args: unknown[]) => mockShowChatScreen(...args),
  showChatListFromRoot: (...args: unknown[]) => mockShowChatList(...args),
  openTerminalFromRoot: (...args: unknown[]) => mockOpenTerminal(...args),
}));

const mockSelectChat = jest.fn();
let mockActiveChatId: string | null = null;
jest.mock("@/lib/canonical-chat-session-context", () => ({
  useCanonicalChatSession: () => ({ activeChatId: mockActiveChatId, selectChat: mockSelectChat }),
}));

const ALICE = {
  handle: "alice",
  runtimeSlot: "primary",
  label: "Main Computer",
  availability: "available",
  kind: "customer",
  gatewayPath: "/vm/alice",
  capabilities: [],
};
const BOB = { ...ALICE, handle: "bob", runtimeSlot: "preview-1", label: "Preview Computer", kind: "preview", gatewayPath: "/vm/bob?runtime=preview-1" };
const mockGateway = {
  computer: ALICE as typeof ALICE | null,
  isComputerPending: false,
  userId: "user_1",
  session: jest.fn(async () => ({ token: "clerk-token", gatewayUrl: "https://app.matrix-os.com/vm/alice" })),
};
jest.mock("@/lib/queries/use-active-gateway", () => ({ useActiveGateway: () => mockGateway }));

const mockFetchComputers = jest.fn();
const mockFetchTerminalSessions = jest.fn();
const mockFetchThreadTerminalSession = jest.fn();
jest.mock("@/lib/requests", () => ({
  fetchComputers: (...args: unknown[]) => mockFetchComputers(...args),
  fetchTerminalSessions: (...args: unknown[]) => mockFetchTerminalSessions(...args),
  fetchThreadTerminalSession: (...args: unknown[]) => mockFetchThreadTerminalSession(...args),
  mobileQueryKeys: { activeComputer: (userId: string) => ["mobile", "computers", "active", userId] },
}));

const mockSaveSelectedHostedComputer = jest.fn();
jest.mock("@/lib/storage", () => ({
  HOSTED_GATEWAY_URL: "https://app.matrix-os.com",
  saveSelectedHostedComputer: (...args: unknown[]) => mockSaveSelectedHostedComputer(...args),
}));

const mockInvalidateQueries = jest.fn(async () => {});
jest.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: mockInvalidateQueries }),
}));

const CHAT_ID = "chat_mobile_reply";
const THREAD_ID = "thread_mobile_attention";
const TERMINAL = "tws_00000000000000000000000000000001:tt_00000000000000000000000000000001";
const CHAT_SCREEN = ["(drawer)", "(tabs)", "(chats)"];
const NOTIFICATION_ID = "0b4f2f3c-6a1e-4d55-9a57-2f1d1c3b5e7a";

const notifications = Notifications as jest.Mocked<typeof Notifications>;
const setGateway = jest.fn();

function tap(data: unknown, identifier = "n1", actionIdentifier = Notifications.DEFAULT_ACTION_IDENTIFIER) {
  return {
    actionIdentifier,
    notification: { request: { identifier, content: { data } } },
  } as unknown as Notifications.NotificationResponse;
}

const chatTap = (handle?: string) => tap(handle
  ? { v: 1, notificationId: NOTIFICATION_ID, handle, target: { type: "chat", chatId: CHAT_ID } }
  : { category: "message", chatId: CHAT_ID });
const threadTap = () => tap({ category: "agent", threadId: THREAD_ID, chatId: "coding-agents" });

/** What the app hands the listener when a notification is tapped while it runs. */
function tapWhileRunning(response: Notifications.NotificationResponse) {
  const listener = notifications.addNotificationResponseReceivedListener.mock.calls.at(-1)![0];
  act(() => listener(response));
}

function renderRouter() {
  return render(<NotificationRouter setGateway={setGateway} />);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSegments = CHAT_SCREEN;
  mockSearchParams = {};
  mockActiveChatId = null;
  mockGateway.computer = ALICE;
  mockGateway.isComputerPending = false;
  notifications.getLastNotificationResponseAsync.mockResolvedValue(null);
  mockFetchTerminalSessions.mockResolvedValue([{ id: TERMINAL }]);
  mockFetchThreadTerminalSession.mockResolvedValue(TERMINAL);
});

describe("tapping a notification while the app runs", () => {
  it("opens the chat it names and forgets the tap", async () => {
    renderRouter();

    tapWhileRunning(chatTap());

    await waitFor(() => expect(mockShowChatScreen).toHaveBeenCalledWith(mockNavigation, mockRouter));
    expect(mockSelectChat).toHaveBeenCalledWith(CHAT_ID);
    expect(mockSelectChat.mock.invocationCallOrder[0]).toBeLessThan(mockShowChatScreen.mock.invocationCallOrder[0]);
    expect(notifications.clearLastNotificationResponseAsync).toHaveBeenCalled();
    expect(mockShowChatList).not.toHaveBeenCalled();
  });

  it("keeps the open chat as it is when the notification is about it", async () => {
    mockActiveChatId = CHAT_ID;
    renderRouter();

    tapWhileRunning(chatTap());

    // Choosing the chat again would drop the model picked for it.
    await waitFor(() => expect(mockShowChatScreen).toHaveBeenCalled());
    expect(mockSelectChat).not.toHaveBeenCalled();
  });

  it("opens the chat list when the notification names nothing", async () => {
    renderRouter();

    tapWhileRunning(tap({ category: "cron" }));

    await waitFor(() => expect(mockShowChatList).toHaveBeenCalledWith(mockNavigation, mockRouter));
    expect(mockSelectChat).not.toHaveBeenCalled();
  });

  it("ignores an action other than a tap", async () => {
    renderRouter();

    tapWhileRunning(tap({ chatId: CHAT_ID }, "n1", "expo.modules.notifications.actions.DISMISS"));

    await act(async () => {});
    expect(mockShowChatScreen).not.toHaveBeenCalled();
    expect(mockShowChatList).not.toHaveBeenCalled();
  });

  it("waits until the shell is on screen", async () => {
    mockSegments = ["sign-in"];
    const view = renderRouter();

    tapWhileRunning(chatTap());
    await act(async () => {});
    expect(mockShowChatScreen).not.toHaveBeenCalled();

    mockSegments = CHAT_SCREEN;
    view.rerender(<NotificationRouter setGateway={setGateway} />);

    await waitFor(() => expect(mockShowChatScreen).toHaveBeenCalledTimes(1));
  });
});

describe("a notification that launched the app", () => {
  it("opens once the sign-in gate has handed over to the shell", async () => {
    notifications.getLastNotificationResponseAsync.mockResolvedValue(chatTap());
    mockSegments = [];
    const view = renderRouter();
    await act(async () => {});
    expect(mockShowChatScreen).not.toHaveBeenCalled();

    mockSegments = CHAT_SCREEN;
    view.rerender(<NotificationRouter setGateway={setGateway} />);

    await waitFor(() => expect(mockShowChatScreen).toHaveBeenCalledTimes(1));
    expect(mockSelectChat).toHaveBeenCalledWith(CHAT_ID);
    expect(notifications.clearLastNotificationResponseAsync).toHaveBeenCalled();
  });

  it("waits for the computer to be known", async () => {
    notifications.getLastNotificationResponseAsync.mockResolvedValue(chatTap());
    mockGateway.isComputerPending = true;
    const view = renderRouter();
    await act(async () => {});
    expect(mockShowChatScreen).not.toHaveBeenCalled();

    mockGateway.isComputerPending = false;
    view.rerender(<NotificationRouter setGateway={setGateway} />);

    await waitFor(() => expect(mockShowChatScreen).toHaveBeenCalledTimes(1));
  });

  it("opens once when the listener reports the same tap", async () => {
    notifications.getLastNotificationResponseAsync.mockResolvedValue(chatTap());
    renderRouter();
    tapWhileRunning(chatTap());

    await waitFor(() => expect(mockShowChatScreen).toHaveBeenCalled());
    await act(async () => {});
    expect(mockShowChatScreen).toHaveBeenCalledTimes(1);
  });
});

describe("a notification about a coding-agent thread", () => {
  it("opens the terminal the thread runs in", async () => {
    renderRouter();

    tapWhileRunning(threadTap());

    await waitFor(() => expect(mockOpenTerminal).toHaveBeenCalledWith(mockNavigation, mockRouter, TERMINAL));
    expect(mockFetchThreadTerminalSession).toHaveBeenCalledWith(
      "clerk-token", "https://app.matrix-os.com/vm/alice", THREAD_ID, expect.any(Number),
    );
  });

  it("opens the chat list when the thread's terminal is not one the phone lists", async () => {
    // A chat's own terminal attaches only with that chat's context.
    mockFetchTerminalSessions.mockResolvedValue([]);
    renderRouter();

    tapWhileRunning(threadTap());

    await waitFor(() => expect(mockShowChatList).toHaveBeenCalled());
    expect(mockOpenTerminal).not.toHaveBeenCalled();
  });

  it("opens the chat list when the thread runs in no terminal", async () => {
    mockFetchThreadTerminalSession.mockResolvedValue(null);
    renderRouter();

    tapWhileRunning(threadTap());

    await waitFor(() => expect(mockShowChatList).toHaveBeenCalled());
    expect(mockOpenTerminal).not.toHaveBeenCalled();
  });

  it("opens the chat list when the thread cannot be read", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    mockFetchThreadTerminalSession.mockRejectedValue(new Error("Thread unavailable."));
    renderRouter();

    tapWhileRunning(threadTap());

    await waitFor(() => expect(mockShowChatList).toHaveBeenCalled());
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("a notification from another computer", () => {
  const BOB_GATEWAY = { id: "matrix-os-cloud:preview-1:bob", url: "https://app.matrix-os.com/vm/bob?runtime=preview-1" };

  it("switches to that computer, then opens the chat", async () => {
    mockFetchComputers.mockResolvedValue({ items: [ALICE, BOB], selectedSlot: null });
    mockSaveSelectedHostedComputer.mockResolvedValue(BOB_GATEWAY);
    renderRouter();

    tapWhileRunning(chatTap("bob"));

    await waitFor(() => expect(mockShowChatScreen).toHaveBeenCalled());
    expect(mockSaveSelectedHostedComputer).toHaveBeenCalledWith(BOB);
    expect(setGateway).toHaveBeenCalledWith(BOB_GATEWAY);
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["mobile", "computers", "active", "user_1"] });
    expect(mockInvalidateQueries.mock.invocationCallOrder[0]).toBeLessThan(mockSelectChat.mock.invocationCallOrder[0]);
    expect(mockSelectChat).toHaveBeenCalledWith(CHAT_ID);
  });

  it("stays on the computer on screen when the notification is from it", async () => {
    renderRouter();

    tapWhileRunning(chatTap("alice"));

    await waitFor(() => expect(mockShowChatScreen).toHaveBeenCalled());
    expect(mockFetchComputers).not.toHaveBeenCalled();
    expect(mockSaveSelectedHostedComputer).not.toHaveBeenCalled();
  });

  it("opens the chat list for a computer this account does not have", async () => {
    mockFetchComputers.mockResolvedValue({ items: [ALICE], selectedSlot: null });
    renderRouter();

    tapWhileRunning(chatTap("bob"));

    await waitFor(() => expect(mockShowChatList).toHaveBeenCalled());
    expect(mockSaveSelectedHostedComputer).not.toHaveBeenCalled();
    expect(mockSelectChat).not.toHaveBeenCalled();
  });

  it("opens the chat list when the account keeps the phone on another computer", async () => {
    // The platform's selected slot outranks the phone's own choice.
    mockFetchComputers.mockResolvedValue({ items: [ALICE, BOB], selectedSlot: "primary" });
    renderRouter();

    tapWhileRunning(chatTap("bob"));

    await waitFor(() => expect(mockShowChatList).toHaveBeenCalled());
    expect(mockSaveSelectedHostedComputer).not.toHaveBeenCalled();
    expect(setGateway).not.toHaveBeenCalled();
    expect(mockSelectChat).not.toHaveBeenCalled();
  });

  it("opens the chat list when no computer is connected", async () => {
    mockGateway.computer = null;
    renderRouter();

    tapWhileRunning(chatTap());

    await waitFor(() => expect(mockShowChatList).toHaveBeenCalled());
    expect(mockSelectChat).not.toHaveBeenCalled();
  });
});

describe("a notification that arrives while the app is open", () => {
  const QUIET = { shouldShowBanner: false, shouldShowList: false, shouldPlaySound: false, shouldSetBadge: false };

  function present(data: unknown) {
    const handler = notifications.setNotificationHandler.mock.calls.at(-1)![0]!;
    return handler.handleNotification(tap(data).notification);
  }

  it("stays quiet for the chat on screen", async () => {
    mockActiveChatId = CHAT_ID;
    renderRouter();

    await expect(present({ chatId: CHAT_ID })).resolves.toEqual(QUIET);
  });

  it("stays quiet for the chat on screen inside a project", async () => {
    mockActiveChatId = CHAT_ID;
    mockSegments = [...CHAT_SCREEN, "projects", "[projectId]", "chats", "[chatId]"];
    renderRouter();

    await expect(present({ chatId: CHAT_ID })).resolves.toEqual(QUIET);
  });

  it("shows the chat's notification once another screen is open", async () => {
    mockActiveChatId = CHAT_ID;
    mockSegments = ["(drawer)", "(tabs)", "agents"];
    renderRouter();

    await expect(present({ chatId: CHAT_ID })).resolves.toMatchObject({ shouldShowBanner: true });
  });

  it("stays quiet for a thread whose terminal is on screen", async () => {
    mockSegments = ["terminal-session", "[session]"];
    mockSearchParams = { session: TERMINAL };
    renderRouter();

    await expect(present({ threadId: THREAD_ID })).resolves.toEqual(QUIET);
    expect(mockFetchThreadTerminalSession).toHaveBeenCalledWith(
      "clerk-token", "https://app.matrix-os.com/vm/alice", THREAD_ID, expect.any(Number),
    );
  });

  it("hands presentation back to the default when it unmounts", () => {
    const view = renderRouter();
    const ours = notifications.setNotificationHandler.mock.calls.at(-1)![0];

    view.unmount();

    expect(notifications.setNotificationHandler.mock.calls.at(-1)![0]).not.toBe(ours);
  });
});
