import {
  agentChatIds,
  chatNeedsUser,
  groupSidePanelChats,
  searchSidePanelChats,
  withoutAgentChats,
} from "../lib/side-panel-chats";

import { C2_CHATS, chatRecord, ids } from "./side-panel-test-utils";

describe("chatNeedsUser", () => {
  it.each(["approval_required", "input_required", "failed"] as const)("is true for %s", (attention) => {
    expect(chatNeedsUser(chatRecord({ id: "chat-1", attention }))).toBe(true);
  });

  it("is false when the chat asks for nothing", () => {
    expect(chatNeedsUser(chatRecord({ id: "chat-1" }))).toBe(false);
  });
});

describe("groupSidePanelChats", () => {
  it("puts the chats that need the person first and leaves the rest as recent, both in the order given", () => {
    const chats = [
      chatRecord({ id: "a" }),
      chatRecord({ id: "b", attention: "input_required" }),
      chatRecord({ id: "c" }),
      chatRecord({ id: "d", attention: "failed" }),
    ];

    const groups = groupSidePanelChats(chats);

    expect(ids(groups.needsYou)).toEqual(["b", "d"]);
    expect(ids(groups.recent)).toEqual(["a", "c"]);
  });

  it("splits the chats of frame C2 into one that needs the person and two recent", () => {
    const groups = groupSidePanelChats(C2_CHATS);

    expect(ids(groups.needsYou)).toEqual(["chat-weekly"]);
    expect(ids(groups.recent)).toEqual(["chat-sales", "chat-q4"]);
  });

  it("has two empty groups for no chats", () => {
    expect(groupSidePanelChats([])).toEqual({ needsYou: [], recent: [] });
  });
});

describe("agentChatIds", () => {
  it("collects the chat of every agent that has one", () => {
    expect(agentChatIds({
      "agent-1": { chatId: "chat-agent-1" },
      "agent-2": { chatId: null },
      "agent-3": { chatId: "chat-agent-3" },
    })).toEqual(["chat-agent-1", "chat-agent-3"]);
  });

  it("is empty while no status is known", () => {
    expect(agentChatIds({})).toEqual([]);
  });
});

describe("withoutAgentChats", () => {
  const chats = [chatRecord({ id: "a" }), chatRecord({ id: "chat-agent-1" }), chatRecord({ id: "b" })];

  it("leaves out the chats that belong to an agent", () => {
    expect(ids(withoutAgentChats(chats, ["chat-agent-1", "chat-agent-9"]))).toEqual(["a", "b"]);
  });

  it("returns the same list while no agent chat is known", () => {
    expect(withoutAgentChats(chats, [])).toBe(chats);
  });
});

describe("searchSidePanelChats", () => {
  const loaded = [
    chatRecord({ id: "plan", title: "Launch plan" }),
    chatRecord({ id: "notes", title: "Meeting notes" }),
    chatRecord({ id: "planning", title: "Q4 PLANNING" }),
  ];

  it("lists the loaded chats whose title contains the query, whatever its case", () => {
    expect(ids(searchSidePanelChats(loaded, "plan", []))).toEqual(["plan", "planning"]);
    expect(ids(searchSidePanelChats(loaded, "PLAN", []))).toEqual(["plan", "planning"]);
  });

  it("adds the server's results after the title matches", () => {
    const results = [chatRecord({ id: "budget", title: "Budget" }), chatRecord({ id: "roadmap", title: "Roadmap" })];

    expect(ids(searchSidePanelChats(loaded, "plan", results))).toEqual(["plan", "planning", "budget", "roadmap"]);
  });

  it("shows a chat once when the server also returns a title match, or returns a chat twice", () => {
    const results = [
      chatRecord({ id: "planning", title: "Q4 PLANNING" }),
      chatRecord({ id: "budget", title: "Budget" }),
      chatRecord({ id: "budget", title: "Budget" }),
    ];

    expect(ids(searchSidePanelChats(loaded, "plan", results))).toEqual(["plan", "planning", "budget"]);
  });

  it("matches the query with the space around it removed", () => {
    expect(ids(searchSidePanelChats(loaded, "  notes ", []))).toEqual(["notes"]);
  });

  it("has nothing for an empty query", () => {
    expect(searchSidePanelChats(loaded, "   ", [chatRecord({ id: "budget" })])).toEqual([]);
  });
});
