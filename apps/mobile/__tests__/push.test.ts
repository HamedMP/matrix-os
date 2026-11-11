import * as Notifications from "expo-notifications";

import {
  createNotificationHandler,
  isNotificationTap,
  parseNotificationDestination,
  type NotificationScreen,
} from "../lib/push";

const CHAT_ID = "chat_mobile_reply";
const THREAD_ID = "thread_mobile_attention";
const TERMINAL = "tws_00000000000000000000000000000001:tt_00000000000000000000000000000001";
const NOTIFICATION_ID = "0b4f2f3c-6a1e-4d55-9a57-2f1d1c3b5e7a";
const CHAT_LIST = { handle: null, target: null };

describe("parseNotificationDestination", () => {
  it("opens the thread of a coding-agent push sent before the notifications router", () => {
    // What the gateway's push channel sends today: `chatId` names the channel's
    // own chat, not a Matrix chat.
    const data = { category: "agent", threadId: THREAD_ID, type: "message", chatId: "coding-agents" };

    expect(parseNotificationDestination(data)).toEqual({
      handle: null,
      target: { type: "thread", threadId: THREAD_ID },
    });
  });

  it("reads the computer a pre-router push names, once its gateway adds it", () => {
    const data = { category: "agent", threadId: THREAD_ID, type: "message", chatId: "coding-agents", handle: "alice" };

    expect(parseNotificationDestination(data)).toEqual({
      handle: "alice",
      target: { type: "thread", threadId: THREAD_ID },
    });
  });

  it("opens the chat a pre-router push names", () => {
    expect(parseNotificationDestination({ category: "message", chatId: CHAT_ID })).toEqual({
      handle: null,
      target: { type: "chat", chatId: CHAT_ID },
    });
  });

  it.each([
    ["an unsafe thread id", { category: "agent", threadId: "../secret", chatId: "coding-agents" }],
    ["an unsafe handle", { category: "message", chatId: CHAT_ID, handle: "../alice" }],
    ["no chat or thread", { category: "cron" }],
    ["nothing", {}],
    ["no data at all", undefined],
    ["a string", "chat_mobile_reply"],
  ])("opens the chat list for a pre-router push with %s", (_case, data) => {
    expect(parseNotificationDestination(data)).toEqual(CHAT_LIST);
  });

  it("opens the chat a router push names, on the computer it names", () => {
    const data = { v: 1, notificationId: NOTIFICATION_ID, handle: "alice", target: { type: "chat", chatId: CHAT_ID } };

    expect(parseNotificationDestination(data)).toEqual({
      handle: "alice",
      target: { type: "chat", chatId: CHAT_ID },
    });
  });

  it("opens the thread a router push names", () => {
    const data = { v: 1, notificationId: NOTIFICATION_ID, handle: "alice", target: { type: "thread", threadId: THREAD_ID } };

    expect(parseNotificationDestination(data)).toEqual({
      handle: "alice",
      target: { type: "thread", threadId: THREAD_ID },
    });
  });

  it.each([
    ["a later version", { v: 2, notificationId: NOTIFICATION_ID, handle: "alice", target: { type: "chat", chatId: CHAT_ID } }],
    ["no notification id", { v: 1, handle: "alice", target: { type: "chat", chatId: CHAT_ID } }],
    ["an unsafe handle", { v: 1, notificationId: NOTIFICATION_ID, handle: "../alice", target: { type: "chat", chatId: CHAT_ID } }],
    ["an unknown target", { v: 1, notificationId: NOTIFICATION_ID, handle: "alice", target: { type: "app", slug: "notes" } }],
    ["a url instead of ids", { v: 1, notificationId: NOTIFICATION_ID, handle: "alice", target: "https://example.com" }],
    // A versioned payload is never read as a pre-router one.
    ["ids outside its target", { v: 1, notificationId: NOTIFICATION_ID, handle: "alice", chatId: CHAT_ID }],
  ])("opens the chat list for a router push with %s", (_case, data) => {
    expect(parseNotificationDestination(data)).toEqual(CHAT_LIST);
  });
});

describe("isNotificationTap", () => {
  it("counts a tap on the notification and nothing else", () => {
    const response = (actionIdentifier: string) => ({ actionIdentifier }) as Notifications.NotificationResponse;

    expect(isNotificationTap(response(Notifications.DEFAULT_ACTION_IDENTIFIER))).toBe(true);
    expect(isNotificationTap(response("expo.modules.notifications.actions.DISMISS"))).toBe(false);
  });
});

describe("createNotificationHandler", () => {
  const SHOWN = { shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: true };
  const QUIET = { shouldShowBanner: false, shouldShowList: false, shouldPlaySound: false, shouldSetBadge: false };

  function notification(data: unknown) {
    return { request: { identifier: "n1", content: { data } } } as unknown as Notifications.Notification;
  }

  function present(
    data: unknown,
    screen: NotificationScreen | null,
    threadTerminal: (threadId: string) => Promise<string | null> = async () => TERMINAL,
  ) {
    const handler = createNotificationHandler({ screen: () => screen, threadTerminal });
    return handler.handleNotification(notification(data));
  }

  const chatPush = { v: 1, notificationId: NOTIFICATION_ID, handle: "alice", target: { type: "chat", chatId: CHAT_ID } };
  const threadPush = { category: "agent", threadId: THREAD_ID, chatId: "coding-agents" };

  it("stays quiet for the chat on screen", async () => {
    await expect(present(chatPush, { kind: "chat", handle: "alice", chatId: CHAT_ID })).resolves.toEqual(QUIET);
  });

  it("stays quiet for a pre-router push about the chat on screen", async () => {
    await expect(present({ chatId: CHAT_ID }, { kind: "chat", handle: "alice", chatId: CHAT_ID })).resolves.toEqual(QUIET);
  });

  it("shows a push about another chat", async () => {
    await expect(present(chatPush, { kind: "chat", handle: "alice", chatId: "chat_other" })).resolves.toEqual(SHOWN);
  });

  it("shows a push about the same chat id on another computer", async () => {
    await expect(present(chatPush, { kind: "chat", handle: "bob", chatId: CHAT_ID })).resolves.toEqual(SHOWN);
  });

  it("shows a push that names a computer while the one on screen is not known", async () => {
    await expect(present(chatPush, { kind: "chat", handle: null, chatId: CHAT_ID })).resolves.toEqual(SHOWN);
  });

  it("stays quiet for a thread whose terminal is on screen", async () => {
    const threadTerminal = jest.fn(async () => TERMINAL);

    await expect(present(threadPush, { kind: "terminal", handle: "alice", session: TERMINAL }, threadTerminal))
      .resolves.toEqual(QUIET);
    expect(threadTerminal).toHaveBeenCalledWith(THREAD_ID);
  });

  it("shows a thread push while another terminal is on screen", async () => {
    const other = "tws_00000000000000000000000000000002:tt_00000000000000000000000000000002";

    await expect(present(threadPush, { kind: "terminal", handle: "alice", session: other })).resolves.toEqual(SHOWN);
  });

  it("shows a thread push when its terminal cannot be found", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const threadTerminal = jest.fn(async (): Promise<string | null> => {
      throw new Error("Thread unavailable.");
    });

    await expect(present(threadPush, { kind: "terminal", handle: "alice", session: TERMINAL }, threadTerminal))
      .resolves.toEqual(SHOWN);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("does not look up a thread unless a terminal is on screen", async () => {
    const threadTerminal = jest.fn(async () => TERMINAL);

    await expect(present(threadPush, { kind: "chat", handle: "alice", chatId: CHAT_ID }, threadTerminal))
      .resolves.toEqual(SHOWN);
    expect(threadTerminal).not.toHaveBeenCalled();
  });

  it.each([
    ["nothing it could be about is on screen", chatPush, null],
    ["the push names nothing", { category: "cron" }, { kind: "chat", handle: "alice", chatId: CHAT_ID }],
  ] as const)("shows a push when %s", async (_case, data, screen) => {
    await expect(present(data, screen)).resolves.toEqual(SHOWN);
  });
});
