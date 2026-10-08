import type { CanonicalChatDetailResponse, CanonicalChatRecord } from "@matrix-os/contracts";

import {
  activeChatRun,
  allowsHomeRelativeAppPaths,
  chatScreenTitle,
  composerPlaceholder,
} from "../components/chat/chat-screen-state";

jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));

function detailOf(value: Record<string, unknown>): CanonicalChatDetailResponse {
  return value as unknown as CanonicalChatDetailResponse;
}

function record(id: string, chat: Record<string, unknown>): CanonicalChatRecord {
  return { chat: { id, ...chat } } as unknown as CanonicalChatRecord;
}

describe("chatScreenTitle", () => {
  const chats = [record("chat_a", { title: "Habit tracker app" }), record("chat_b", { title: " ", lastMessagePreview: "Plan my week" })];

  it("is New chat while no chat is open", () => {
    expect(chatScreenTitle(null, null, chats)).toBe("New chat");
  });

  it("is the open chat's title, from its detail when that has loaded", () => {
    const detail = detailOf({ record: record("chat_a", { title: "Habit tracker, renamed" }) });

    expect(chatScreenTitle("chat_a", detail, chats)).toBe("Habit tracker, renamed");
  });

  it("falls back to the chat list while the detail is still loading", () => {
    expect(chatScreenTitle("chat_a", null, chats)).toBe("Habit tracker app");
  });

  it("uses the last message for a chat that has no title yet, as the side panel does", () => {
    expect(chatScreenTitle("chat_b", null, chats)).toBe("Plan my week");
  });

  it("is New chat for a chat nothing is known about yet", () => {
    expect(chatScreenTitle("chat_new", null, chats)).toBe("New chat");
    expect(chatScreenTitle("chat_new", detailOf({ record: record("chat_new", { title: "" }) }), chats)).toBe("New chat");
  });
});

describe("composerPlaceholder", () => {
  it("invites a first message on a new chat and a reply in an existing one", () => {
    expect(composerPlaceholder({ connected: true, chatOpen: false })).toBe("Ask anything");
    expect(composerPlaceholder({ connected: true, chatOpen: true })).toBe("Reply…");
  });

  it("says it is signing in while there is nobody to send as", () => {
    expect(composerPlaceholder({ connected: false, chatOpen: false })).toBe("Signing in…");
    expect(composerPlaceholder({ connected: false, chatOpen: true })).toBe("Signing in…");
  });
});

describe("activeChatRun", () => {
  it("is the latest run that has not finished", () => {
    const detail = detailOf({ runs: [
      { id: "run_1", status: "completed" },
      { id: "run_2", status: "running" },
      { id: "run_3", status: "accepted" },
      { id: "run_4", status: "failed" },
    ] });

    expect(activeChatRun(detail)?.id).toBe("run_3");
  });

  it("is nothing when every run has finished, or there is no chat", () => {
    expect(activeChatRun(detailOf({ runs: [{ id: "run_1", status: "completed" }, { id: "run_2", status: "aborted" }] }))).toBeUndefined();
    expect(activeChatRun(null)).toBeUndefined();
  });
});

describe("allowsHomeRelativeAppPaths", () => {
  const messages = [{ id: "msg_home", runId: "run_home" }, { id: "msg_rooted", runId: "run_rooted" }, { id: "msg_loose" }];
  const runs = [{ id: "run_home" }, { id: "run_rooted", executionRoot: { kind: "bot_workspace", botId: "bot_abcdefgh" } }];

  it("allows them for a reply in a chat outside any project whose run had no workspace of its own", () => {
    const detail = detailOf({ record: { projectId: null }, messages, runs });

    expect(allowsHomeRelativeAppPaths(detail, "msg_home")).toBe(true);
    expect(allowsHomeRelativeAppPaths(detail, "msg_loose")).toBe(true);
  });

  it("does not allow them for a run that worked in its own workspace", () => {
    expect(allowsHomeRelativeAppPaths(detailOf({ record: { projectId: null }, messages, runs }), "msg_rooted")).toBe(false);
  });

  it("does not allow them in a project's chat, or before the chat has loaded", () => {
    expect(allowsHomeRelativeAppPaths(detailOf({ record: { projectId: "project_a" }, messages, runs }), "msg_home")).toBe(false);
    expect(allowsHomeRelativeAppPaths(null, "msg_home")).toBe(false);
  });
});
