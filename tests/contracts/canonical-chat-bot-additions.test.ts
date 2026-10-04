import { describe, expect, it } from "vitest";
import {
  CanonicalChatExecutionRootRefSchema,
  CanonicalChatOutboxEventTypeSchema,
  CanonicalProviderDriverKindSchema,
  ChatEventWireVersionSchema,
  canonicalExecutionRootProjectId,
  isChatAgentDriver,
  projectChatEventTypeForWire,
} from "@matrix-os/contracts";

const BOT_EVENT_TYPES = [
  "bot.created",
  "interaction.requested",
  "interaction.resolved",
  "bot.task.updated",
  "bot.authority.changed",
  "bot.memory.remembered",
] as const;

describe("canonical Chat additions for conversational bots", () => {
  it("accepts a bot workspace execution root keyed only by bot id", () => {
    expect(CanonicalChatExecutionRootRefSchema.parse({ kind: "bot_workspace", botId: "bot_research1" }))
      .toEqual({ kind: "bot_workspace", botId: "bot_research1" });
    expect(CanonicalChatExecutionRootRefSchema.safeParse({ kind: "bot_workspace", botId: "research" }).success).toBe(false);
    expect(CanonicalChatExecutionRootRefSchema.safeParse({ kind: "bot_workspace", botId: "bot_research1", path: "/home/matrix" }).success)
      .toBe(false);
  });

  it("reports no owning Project for bot workspace roots", () => {
    expect(canonicalExecutionRootProjectId({ kind: "bot_workspace", botId: "bot_research1" })).toBeUndefined();
    expect(canonicalExecutionRootProjectId({ kind: "project", projectId: "proj_1" })).toBe("proj_1");
    expect(canonicalExecutionRootProjectId({ kind: "worktree", projectId: "proj_1", worktreeId: "wt_1" })).toBe("proj_1");
  });

  it("adds the matrix_bot driver kind and admits it as a Chat agent driver", () => {
    expect(CanonicalProviderDriverKindSchema.parse("matrix_bot")).toBe("matrix_bot");
    expect(isChatAgentDriver("matrix_bot")).toBe(true);
    expect(isChatAgentDriver("hermes")).toBe(true);
    expect(isChatAgentDriver("codex")).toBe(true);
    expect(isChatAgentDriver("pi")).toBe(false);
  });

  it("adds bot outbox event types", () => {
    for (const eventType of BOT_EVENT_TYPES) {
      expect(CanonicalChatOutboxEventTypeSchema.parse(eventType)).toBe(eventType);
    }
  });

  it("projects bot events to chat.updated for clients that did not opt into event wire v1", () => {
    expect(ChatEventWireVersionSchema.parse(undefined)).toBe("0");
    for (const eventType of BOT_EVENT_TYPES) {
      expect(projectChatEventTypeForWire(eventType, "0")).toBe("chat.updated");
      expect(projectChatEventTypeForWire(eventType, "1")).toBe(eventType);
    }
    expect(projectChatEventTypeForWire("run.message", "0")).toBe("run.message");
    expect(ChatEventWireVersionSchema.safeParse("2").success).toBe(false);
  });
});
