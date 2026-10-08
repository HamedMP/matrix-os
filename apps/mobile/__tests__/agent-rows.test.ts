import type { CanonicalChatRecord, ChatAgent } from "@matrix-os/contracts";

import { agentListRows } from "../components/agents/agent-rows";
import {
  AGENT_STATUS_ENTRY_LOADING,
  AGENT_STATUS_ENTRY_UNAVAILABLE,
  AGENT_STATUS_IDLE,
  type AgentStatusEntry,
} from "../lib/agent-status";

const now = new Date("2026-10-08T12:00:00.000Z");

function agent(id: string, name: string, description = ""): ChatAgent {
  return { id, name, description } as ChatAgent;
}

function chat(id: string, activityAt: string | null, updatedAt = "2026-10-01T08:00:00.000Z"): CanonicalChatRecord {
  return { chat: { id, activityAt, updatedAt } } as unknown as CanonicalChatRecord;
}

function entry(overrides: Partial<AgentStatusEntry>): AgentStatusEntry {
  return { state: "idle", label: "No open tasks", chatId: null, lastActivityAt: null, ...overrides };
}

function rowFor(status: AgentStatusEntry | undefined, description = "Briefs you before every sales call") {
  const research = agent("bot_research", "Account research", description);
  const statuses = status ? { [research.id]: status } : {};
  return agentListRows([research], statuses, [chat("chat_research", "2026-10-08T11:58:00.000Z")], now)[0];
}

describe("agent list rows", () => {
  it("carries the agent's id and name, in the order of the list", () => {
    const rows = agentListRows(
      [agent("bot_a", "Account research"), agent("bot_b", "My inbox")],
      {},
      [],
      now,
    );

    expect(rows.map((row) => [row.id, row.name])).toEqual([
      ["bot_a", "Account research"],
      ["bot_b", "My inbox"],
    ]);
  });

  it("marks an agent that needs the person as waiting and shows what it waits for", () => {
    const row = rowFor(entry({ state: "attention", label: "Waiting for your approval", chatId: "chat_research" }));

    expect(row.tone).toBe("waiting");
    expect(row.subtitle).toBe("Waiting for your approval");
  });

  it("marks a working agent as active and shows what it is doing", () => {
    const row = rowFor(entry({ state: "working", label: "Working", chatId: "chat_research" }));

    expect(row.tone).toBe("active");
    expect(row.subtitle).toBe("Working");
  });

  it("gives a finished agent no dot and keeps its status line", () => {
    const row = rowFor(entry({ state: "completed", label: "Done", chatId: "chat_research" }));

    expect(row.tone).toBeNull();
    expect(row.subtitle).toBe("Done");
  });

  it("keeps the status line of an idle agent whose task is only waiting its turn", () => {
    const row = rowFor(entry({ state: "idle", label: "Queued", chatId: "chat_research" }));

    expect(row.tone).toBeNull();
    expect(row.subtitle).toBe("Queued");
  });

  it.each<[string, AgentStatusEntry | undefined]>([
    ["has no open tasks", { ...AGENT_STATUS_IDLE, chatId: "chat_research", lastActivityAt: null }],
    ["is still loading its status", AGENT_STATUS_ENTRY_LOADING],
    ["has no readable status", AGENT_STATUS_ENTRY_UNAVAILABLE],
    ["has no status entry yet", undefined],
  ])("shows the description of an agent that %s", (_case, status) => {
    const row = rowFor(status);

    expect(row.tone).toBeNull();
    expect(row.subtitle).toBe("Briefs you before every sales call");
  });

  it("leaves the second line out when there is no description to fall back on", () => {
    expect(rowFor(AGENT_STATUS_ENTRY_UNAVAILABLE, "").subtitle).toBeUndefined();
    expect(rowFor({ ...AGENT_STATUS_IDLE, chatId: null, lastActivityAt: null }, "").subtitle).toBeUndefined();
  });

  it("shows when the agent's chat was last active", () => {
    const row = rowFor(entry({ state: "working", label: "Working", chatId: "chat_research" }));

    expect(row.time).toBe("2m");
  });

  it("falls back to the chat's update time when it has no activity time", () => {
    const research = agent("bot_research", "Account research");
    const rows = agentListRows(
      [research],
      { [research.id]: entry({ chatId: "chat_research" }) },
      [chat("chat_research", null, "2026-10-08T09:00:00.000Z")],
      now,
    );

    expect(rows[0].time).toBe("3h");
  });

  it("shows no time when the agent has no chat, or its chat is not in the list", () => {
    expect(rowFor(entry({ chatId: null })).time).toBe("");
    expect(rowFor(entry({ chatId: "chat_elsewhere" })).time).toBe("");
  });

  it("has no category to colour the mascot by: the server sends none", () => {
    expect(rowFor(entry({}))).not.toHaveProperty("category");
  });
});
