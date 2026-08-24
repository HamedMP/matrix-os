import { describe, expect, it } from "vitest";
import {
  AgentThreadSnapshotSchema,
  CanonicalChatCompatibilityProjectionSchema,
  KernelConversationHistoryResponseSchema,
  KernelConversationSummarySchema,
  mapAgentThreadToCanonicalChatProjection,
  mapKernelConversationToCanonicalChatProjection,
} from "../../packages/contracts/src/index.js";

const now = "2026-08-25T00:00:00.000Z";
const nowMs = Date.parse(now);

describe("canonical Chat compatibility mappers", () => {
  it("maps a Hermes conversation page without preserving renderer-owned identity", () => {
    const summary = KernelConversationSummarySchema.parse({
      id: "legacy:hermes:123",
      preview: "Continue the project work",
      messageCount: 2,
      createdAt: nowMs,
      updatedAt: nowMs,
      context: {
        projectId: "matrix-os",
        projectName: "Matrix OS",
        projectKind: "github",
        repositoryLabel: "HamedMP/matrix-os",
        status: "ready",
      },
    });
    const history = KernelConversationHistoryResponseSchema.parse({
      id: summary.id,
      createdAt: nowMs,
      updatedAt: nowMs,
      context: summary.context,
      totalCount: 2,
      messages: [
        { index: 0, role: "user", content: "Continue the project work", contentTruncated: false, timestamp: nowMs },
        { index: 1, role: "assistant", content: "Working on it.", contentTruncated: false, timestamp: nowMs },
      ],
      hasMore: false,
      limit: 50,
    });

    const projection = CanonicalChatCompatibilityProjectionSchema.parse(
      mapKernelConversationToCanonicalChatProjection({
        chatId: "chat_imported_hermes",
        ownerScope: { type: "personal", ownerId: "user_demo" },
        instanceId: "hermes_primary",
        model: "claude-opus-4-6",
        turnId: "cturn_imported_hermes",
        summary,
        history,
      }),
    );

    expect(projection.source).toEqual({ kind: "hermes_conversation", id: summary.id });
    expect(projection.chat.id).toBe("chat_imported_hermes");
    expect(projection.chat.providerBinding).toEqual({
      driverKind: "hermes",
      instanceId: "hermes_primary",
      lockedAtTurnId: "cturn_imported_hermes",
    });
    expect(projection.messages.map((message) => message.role)).toEqual(["user", "assistant"]);

    const draft = mapKernelConversationToCanonicalChatProjection({
      chatId: "chat_imported_hermes_draft",
      ownerScope: { type: "personal", ownerId: "user_demo" },
      instanceId: "hermes_primary",
      model: "claude-opus-4-6",
      summary: { ...summary, id: "legacy:hermes:draft", messageCount: 0, preview: "" },
      history: { ...history, id: "legacy:hermes:draft", totalCount: 0, messages: [] },
    });
    expect(draft.chat.providerBinding).toBeUndefined();
  });

  it("maps a coding-agent thread into canonical messages and bounded activity", () => {
    const thread = AgentThreadSnapshotSchema.parse({
      thread: {
        id: "thread_legacy",
        providerId: "codex",
        title: "Implement contracts",
        status: "running",
        attention: "none",
        projectId: "matrix-os",
        createdAt: now,
        updatedAt: now,
      },
      events: {
        items: [
          {
            eventId: "evt_user",
            threadId: "thread_legacy",
            occurredAt: now,
            type: "user.message",
            messageId: "legacy_user",
            text: "Implement the shared contracts.",
            clientRequestId: "req_legacy",
            turnId: "turn_legacy",
          },
          {
            eventId: "evt_delta",
            threadId: "thread_legacy",
            occurredAt: now,
            type: "assistant.text.delta",
            messageId: "legacy_assistant",
            delta: "Starting with tests.",
          },
          {
            eventId: "evt_complete",
            threadId: "thread_legacy",
            occurredAt: now,
            type: "assistant.text.completed",
            messageId: "legacy_assistant",
          },
          {
            eventId: "evt_tool",
            threadId: "thread_legacy",
            occurredAt: now,
            type: "tool.started",
            toolCallId: "tool_legacy",
            displayName: "Read",
            kind: "file",
          },
        ],
        hasMore: false,
        limit: 200,
      },
    });

    const projection = CanonicalChatCompatibilityProjectionSchema.parse(
      mapAgentThreadToCanonicalChatProjection({
        chatId: "chat_imported_thread",
        ownerScope: { type: "personal", ownerId: "user_demo" },
        instanceId: "codex_primary",
        model: "gpt-5.6-sol",
        driverKind: "codex",
        turnId: "cturn_imported",
        runId: "run_imported",
        snapshot: thread,
      }),
    );

    expect(projection.source).toEqual({ kind: "coding_agent_thread", id: "thread_legacy" });
    expect(projection.messages.map((message) => message.parts[0])).toEqual([
      { type: "text", text: "Implement the shared contracts." },
      { type: "text", text: "Starting with tests." },
    ]);
    expect(projection.activities).toHaveLength(1);
    expect(JSON.stringify(projection)).not.toContain("providerState");

    const unsafeSnapshot = JSON.parse(JSON.stringify(thread));
    unsafeSnapshot.events.items[3].displayName = "/home/matrix/private";
    expect(() => mapAgentThreadToCanonicalChatProjection({
      chatId: "chat_imported_thread",
      ownerScope: { type: "personal", ownerId: "user_demo" },
      instanceId: "codex_primary",
      model: "gpt-5.6-sol",
      driverKind: "codex",
      turnId: "cturn_imported",
      runId: "run_imported",
      snapshot: unsafeSnapshot,
    })).toThrow();
  });
});
