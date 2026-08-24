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
            eventId: "evt_turn_accepted",
            threadId: "thread_legacy",
            occurredAt: now,
            type: "turn.accepted",
            turnId: "turn_legacy",
            clientRequestId: "req_legacy",
            acceptedAt: now,
          },
          {
            eventId: "evt_user",
            threadId: "thread_legacy",
            occurredAt: now,
            type: "user.message",
            messageId: "legacy_user",
            text: "Implement the shared contracts.",
            clientRequestId: "req_legacy",
            turnId: "turn_legacy",
            attachments: [{
              id: "attachment_legacy",
              kind: "file",
              label: "contract.ts",
              path: "packages/contracts/src/index.ts",
              mimeType: "text/plain",
              sizeBytes: 512,
            }],
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
          {
            eventId: "evt_tool_output",
            threadId: "thread_legacy",
            occurredAt: now,
            type: "tool.output",
            toolCallId: "tool_legacy",
            text: "Read the contracts.",
            truncated: false,
          },
          {
            eventId: "evt_review",
            threadId: "thread_legacy",
            occurredAt: now,
            type: "review.ready",
            reviewId: "review_legacy",
            summary: { changedFileCount: 1, additions: 2, deletions: 0, partial: false },
          },
          {
            eventId: "evt_terminal",
            threadId: "thread_legacy",
            occurredAt: now,
            type: "terminal.bound",
            terminalSessionId: "terminal_legacy",
          },
          {
            eventId: "evt_turn_status",
            threadId: "thread_legacy",
            occurredAt: now,
            type: "turn.status",
            turnId: "turn_legacy",
            status: "running",
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
    expect(projection.messages[0]?.parts[1]).toEqual({
      type: "attachment_reference",
      attachmentId: "attachment_legacy",
      kind: "file",
      label: "contract.ts",
      mimeType: "text/plain",
      sizeBytes: 512,
    });
    expect(projection.messages.every((message) => message.turnId === "cturn_legacy_1")).toBe(true);
    expect(projection.messages[1]?.state).toBe("pending");
    expect(projection.chat.providerBinding?.lockedAtTurnId).toBe("cturn_legacy_1");
    expect(projection.activities.map((activity) => activity.type)).toEqual([
      "turn.status",
      "tool.progress",
      "tool.output",
      "review.ready",
      "terminal.bound",
      "turn.status",
    ]);
    expect(JSON.stringify(projection)).not.toContain("providerState");

    const unsafeSnapshot = JSON.parse(JSON.stringify(thread));
    unsafeSnapshot.events.items[4].displayName = "/home/matrix/private";
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

  it("preserves multiple legacy Turns and maps every non-message activity class", () => {
    const base = { threadId: "thread_two_turns", occurredAt: now };
    const thread = AgentThreadSnapshotSchema.parse({
      thread: {
        id: base.threadId,
        providerId: "codex",
        title: "Two turns",
        status: "failed",
        attention: "failed",
        createdAt: now,
        updatedAt: now,
      },
      events: {
        items: [
          { ...base, eventId: "evt_accept_1", type: "turn.accepted", turnId: "turn_one", clientRequestId: "req_one", acceptedAt: now },
          { ...base, eventId: "evt_user_1", type: "user.message", messageId: "user_one", text: "First", clientRequestId: "req_one", turnId: "turn_one" },
          { ...base, eventId: "evt_status_1", type: "turn.status", turnId: "turn_one", status: "completed" },
          { ...base, eventId: "evt_accept_2", type: "turn.accepted", turnId: "turn_two", clientRequestId: "req_two", acceptedAt: now },
          { ...base, eventId: "evt_user_2", type: "user.message", messageId: "user_two", text: "Second", clientRequestId: "req_two", turnId: "turn_two" },
          { ...base, eventId: "evt_output_2", type: "tool.output", toolCallId: "tool_two", text: "Bounded output", truncated: true },
          { ...base, eventId: "evt_review_2", type: "review.ready", reviewId: "review_two", summary: { changedFileCount: 1, additions: 3, deletions: 1, partial: false } },
          { ...base, eventId: "evt_terminal_2", type: "terminal.bound", terminalSessionId: "terminal_two" },
          { ...base, eventId: "evt_error_2", type: "thread.error", error: { code: "run_failed", safeMessage: "The Run stopped safely.", retryable: true, recoveryActions: ["retry"] } },
        ],
        hasMore: false,
        limit: 200,
      },
    });

    const projection = mapAgentThreadToCanonicalChatProjection({
      chatId: "chat_two_turns",
      ownerScope: { type: "personal", ownerId: "user_demo" },
      instanceId: "codex_primary",
      model: "gpt-5.6-sol",
      driverKind: "codex",
      turnId: "cturn_fallback",
      runId: "run_fallback",
      snapshot: thread,
    });

    expect(projection.messages.map((message) => message.turnId)).toEqual([
      "cturn_legacy_1",
      "cturn_legacy_2",
    ]);
    expect(projection.chat.providerBinding?.lockedAtTurnId).toBe("cturn_legacy_1");
    expect(projection.activities.slice(-4).map((activity) => [activity.type, activity.runId])).toEqual([
      ["tool.output", "run_legacy_2"],
      ["review.ready", "run_legacy_2"],
      ["terminal.bound", "run_legacy_2"],
      ["run.error", "run_legacy_2"],
    ]);

    const unsafeOutput = JSON.parse(JSON.stringify(thread));
    unsafeOutput.events.items[5].text = "Postgres failed at /home/matrix/private";
    const safeProjection = mapAgentThreadToCanonicalChatProjection({
      chatId: "chat_two_turns",
      ownerScope: { type: "personal", ownerId: "user_demo" },
      instanceId: "codex_primary",
      model: "gpt-5.6-sol",
      driverKind: "codex",
      turnId: "cturn_fallback",
      runId: "run_fallback",
      snapshot: unsafeOutput,
    });
    expect(JSON.stringify(safeProjection)).not.toContain("/home/matrix/private");
    expect(safeProjection.activities.find((activity) => activity.type === "tool.output")).toMatchObject({
      text: "Tool output is unavailable.",
      truncated: true,
    });
    for (const unsafeText of [
      "AWS_SECRET_ACCESS_KEY=supersecret",
      "api_key=supersecret",
      "Authorization: Basic dXNlcjpwYXNz",
      "ghp_123456789012345678901234567890123456",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "-----BEGIN ENCRYPTED PRIVATE KEY-----",
      "Cookie: session=abc123",
      "credential=supersecret",
    ]) {
      const unsafeCredential = JSON.parse(JSON.stringify(thread));
      unsafeCredential.events.items[5].text = unsafeText;
      const credentialProjection = mapAgentThreadToCanonicalChatProjection({
        chatId: "chat_two_turns",
        ownerScope: { type: "personal", ownerId: "user_demo" },
        instanceId: "codex_primary",
        model: "gpt-5.6-sol",
        driverKind: "codex",
        turnId: "cturn_fallback",
        runId: "run_fallback",
        snapshot: unsafeCredential,
      });
      expect(JSON.stringify(credentialProjection)).not.toContain(unsafeText);
    }
  });

  it("keeps an empty queued coding thread as an unbound draft", () => {
    const thread = AgentThreadSnapshotSchema.parse({
      thread: {
        id: "thread_empty",
        providerId: "codex",
        title: "Empty draft",
        status: "queued",
        createdAt: now,
        updatedAt: now,
      },
      events: { items: [], hasMore: false, limit: 200 },
    });
    const projection = mapAgentThreadToCanonicalChatProjection({
      chatId: "chat_empty",
      ownerScope: { type: "personal", ownerId: "user_demo" },
      instanceId: "codex_primary",
      model: "gpt-5.6-sol",
      driverKind: "codex",
      turnId: "cturn_fallback",
      runId: "run_fallback",
      snapshot: thread,
    });

    expect(projection.chat.providerBinding).toBeUndefined();
    expect(projection.chat.activeRun).toBeUndefined();
  });

  it("marks incomplete assistant output failed when the legacy thread terminates unsuccessfully", () => {
    const thread = AgentThreadSnapshotSchema.parse({
      thread: {
        id: "thread_failed_partial",
        providerId: "codex",
        title: "Failed partial output",
        status: "failed",
        attention: "failed",
        createdAt: now,
        updatedAt: now,
      },
      events: {
        items: [
          { eventId: "evt_failed_accept", threadId: "thread_failed_partial", occurredAt: now, type: "turn.accepted", turnId: "turn_failed", clientRequestId: "req_failed", acceptedAt: now },
          { eventId: "evt_failed_user", threadId: "thread_failed_partial", occurredAt: now, type: "user.message", messageId: "user_failed", text: "Try the task", clientRequestId: "req_failed", turnId: "turn_failed" },
          { eventId: "evt_failed_delta", threadId: "thread_failed_partial", occurredAt: now, type: "assistant.text.delta", messageId: "assistant_failed", delta: "Partial result" },
          { eventId: "evt_failed_completed", threadId: "thread_failed_partial", occurredAt: now, type: "assistant.text.completed", messageId: "assistant_failed" },
          { eventId: "evt_failed_error", threadId: "thread_failed_partial", occurredAt: now, type: "thread.error", error: { code: "run_failed", safeMessage: "The Run stopped safely.", retryable: true } },
        ],
        hasMore: false,
        limit: 200,
      },
    });
    const projection = mapAgentThreadToCanonicalChatProjection({
      chatId: "chat_failed_partial",
      ownerScope: { type: "personal", ownerId: "user_demo" },
      instanceId: "codex_primary",
      model: "gpt-5.6-sol",
      driverKind: "codex",
      turnId: "cturn_fallback",
      runId: "run_fallback",
      snapshot: thread,
    });

    expect(projection.messages[1]).toMatchObject({ role: "assistant", state: "failed" });
  });
});
