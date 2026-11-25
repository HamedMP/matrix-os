import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentThreadEventSchema } from "@matrix-os/contracts";
import { registerCodingAgentAttentionNotifications } from "../../packages/gateway/src/coding-agents/attention-notifications.js";
import {
  createCodingAgentThreadStore,
  type CodingAgentProviderAdapter,
} from "../../packages/gateway/src/coding-agents/thread-store.js";
import { ingestCodexTranscript } from "../../packages/gateway/src/coding-agents/codex-event-batches.js";
import type { ChannelReply } from "../../packages/gateway/src/channels/types.js";
import type { RequestPrincipal } from "../../packages/gateway/src/request-principal.js";

const principal: RequestPrincipal = { userId: "owner_user", source: "jwt" };
const now = new Date("2026-07-07T12:00:00.000Z");

function approvalProvider(): CodingAgentProviderAdapter {
  return {
    providerId: "codex",
    startThread({ thread, nextEventId }) {
      return [
        AgentThreadEventSchema.parse({
          type: "approval.requested",
          eventId: nextEventId(),
          threadId: thread.id,
          occurredAt: now.toISOString(),
          approval: {
            approvalId: "appr_safe_action",
            threadId: thread.id,
            title: "Approve command",
            safeDescription: "Approve the next step.",
            risk: "medium",
            actionKind: "command",
            allowedDecisions: ["approve", "decline"],
            correlationId: "corr_safe_action",
          },
        }),
      ];
    },
  };
}

function repeatedApprovalProvider(): CodingAgentProviderAdapter {
  return {
    ...approvalProvider(),
    submitApproval({ thread, nextEventId }) {
      return [
        AgentThreadEventSchema.parse({
          type: "approval.requested",
          eventId: nextEventId(),
          threadId: thread.id,
          occurredAt: now.toISOString(),
          approval: {
            approvalId: "appr_followup_action",
            threadId: thread.id,
            title: "Approve next command",
            safeDescription: "Approve the follow-up step.",
            risk: "medium",
            actionKind: "command",
            allowedDecisions: ["approve", "decline"],
            correlationId: "corr_followup_action",
          },
        }),
      ];
    },
  };
}

function inputProvider(): CodingAgentProviderAdapter {
  return {
    providerId: "codex",
    startThread({ thread, nextEventId }) {
      return [
        AgentThreadEventSchema.parse({
          type: "user_input.requested",
          eventId: nextEventId(),
          threadId: thread.id,
          occurredAt: now.toISOString(),
          request: {
            requestId: "req_more_context",
            threadId: thread.id,
            title: "Need more context",
            safeDescription: "Add the missing test command.",
            correlationId: "corr_more_context",
          },
        }),
      ];
    },
  };
}

function failedProvider(): CodingAgentProviderAdapter {
  return {
    providerId: "codex",
    startThread({ thread, nextEventId }) {
      return [
        AgentThreadEventSchema.parse({
          type: "thread.error",
          eventId: nextEventId(),
          threadId: thread.id,
          occurredAt: now.toISOString(),
          error: {
            code: "provider_run_failed",
            safeMessage: "Agent run could not continue. Try again.",
            retryable: true,
            recoveryActions: ["retry"],
          },
        }),
        AgentThreadEventSchema.parse({
          type: "thread.completed",
          eventId: nextEventId(),
          threadId: thread.id,
          occurredAt: now.toISOString(),
          outcome: "failed",
        }),
      ];
    },
  };
}

function completedProvider(): CodingAgentProviderAdapter {
  return {
    providerId: "codex",
    startThread({ thread, nextEventId }) {
      return [
        AgentThreadEventSchema.parse({
          type: "thread.completed",
          eventId: nextEventId(),
          threadId: thread.id,
          occurredAt: now.toISOString(),
          outcome: "completed",
        }),
      ];
    },
  };
}

describe("coding agent attention notifications", () => {
  it("emits a safe push notification when a thread starts waiting for approval", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-coding-agent-attention-notifications-"));
    const send = vi.fn<(reply: ChannelReply) => Promise<void>>().mockResolvedValue(undefined);
    const threads = createCodingAgentThreadStore({
      homePath,
      now: () => now,
      providers: [approvalProvider()],
    });
    const subscription = registerCodingAgentAttentionNotifications({ threads, send });

    const created = await threads.createThread(principal, {
      providerId: "codex",
      prompt: "Review the next command.",
      clientRequestId: "req_attention_push",
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      channelId: "push",
      chatId: "coding-agents",
      ownerId: principal.userId,
      text: "Agent needs approval.",
      metadata: {
        category: "agent",
        threadId: created.snapshot.thread.id,
      },
    });

    subscription.dispose();
  });

  it("emits a safe push notification when a thread waits for user input", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-coding-agent-attention-notifications-"));
    const send = vi.fn<(reply: ChannelReply) => Promise<void>>().mockResolvedValue(undefined);
    const threads = createCodingAgentThreadStore({
      homePath,
      now: () => now,
      providers: [inputProvider()],
    });
    const subscription = registerCodingAgentAttentionNotifications({ threads, send });

    const created = await threads.createThread(principal, {
      providerId: "codex",
      prompt: "Continue the run.",
      clientRequestId: "req_input_push",
    });

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      ownerId: principal.userId,
      text: "Agent needs input.",
      metadata: {
        category: "agent",
        threadId: created.snapshot.thread.id,
      },
    }));

    subscription.dispose();
  });

  it("emits only one safe push notification for a failed thread event batch", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-coding-agent-attention-notifications-"));
    const send = vi.fn<(reply: ChannelReply) => Promise<void>>().mockResolvedValue(undefined);
    const threads = createCodingAgentThreadStore({
      homePath,
      now: () => now,
      providers: [failedProvider()],
    });
    const subscription = registerCodingAgentAttentionNotifications({ threads, send });

    const created = await threads.createThread(principal, {
      providerId: "codex",
      prompt: "Run the failing command.",
      clientRequestId: "req_failed_push",
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      ownerId: principal.userId,
      text: "Agent run needs attention.",
      metadata: {
        category: "agent",
        threadId: created.snapshot.thread.id,
      },
    }));

    subscription.dispose();
  });

  it("emits a safe push notification when a thread completes successfully", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-coding-agent-attention-notifications-"));
    const send = vi.fn<(reply: ChannelReply) => Promise<void>>().mockResolvedValue(undefined);
    const threads = createCodingAgentThreadStore({
      homePath,
      now: () => now,
      providers: [completedProvider()],
    });
    const subscription = registerCodingAgentAttentionNotifications({ threads, send });

    const created = await threads.createThread(principal, {
      providerId: "codex",
      prompt: "Finish the task.",
      clientRequestId: "req_completed_push",
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      ownerId: principal.userId,
      text: "Agent run completed.",
      metadata: {
        category: "agent",
        threadId: created.snapshot.thread.id,
      },
    }));

    subscription.dispose();
  });

  it.each(["codex", "pi", "opencode"] as const)("keeps canonical %s completion/failure pushes while suppressing approval/input duplicates", async providerId => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-a6-canonical-terminal-"));
    try {
      for (const [factory, kind, body] of [
        [approvalProvider, "approval", "Agent needs approval."],
        [inputProvider, "input", "Agent needs input."],
        [completedProvider, "completed", "Agent run completed."],
        [failedProvider, "failed", "Agent run needs attention."],
      ] as const) {
        const send = vi.fn<(reply: ChannelReply) => Promise<void>>().mockResolvedValue(undefined);
        const isAttentionPushEnabled = vi.fn().mockResolvedValue(true);
        const threads = createCodingAgentThreadStore({ homePath, now: () => now, providers: [{ ...factory(), providerId }] });
        const subscription = registerCodingAgentAttentionNotifications({ threads, send,
          isCanonicalThread: async () => true, preferences: { isAttentionPushEnabled } });
        try {
          const created = await threads.createThread(principal, { providerId, prompt: "Run the task.", clientRequestId: `req_${providerId}_${kind}` });
          // Drain the async ownership/preference checks, including the suppressed path.
          await new Promise<void>(resolve => setImmediate(resolve));
          if (kind === "approval" || kind === "input") expect(send).not.toHaveBeenCalled();
          else {
            expect(isAttentionPushEnabled).toHaveBeenCalledWith({ ownerId: principal.userId, threadId: created.snapshot.thread.id, kind });
            expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ownerId: principal.userId, text: body,
              metadata: { category: "agent", threadId: created.snapshot.thread.id } }));
          }
        } finally { subscription.dispose(); await threads.shutdownTurns(); }
      }
    } finally { await rm(homePath, { recursive: true, force: true }); }
  });

  it.each(["approval", "input"] as const)("retains terminal pushes when a recovered Codex transcript batch starts with %s", async requestKind => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-a6-canonical-batch-"));
    const threads = createCodingAgentThreadStore({ homePath, now: () => now, providers: [{ providerId: "codex",
      startThread: () => ({ events: [], resumeState: { conversationId: "sess_mixed" } }) }] });
    const send = vi.fn<(reply: ChannelReply) => Promise<void>>().mockResolvedValue(undefined);
    const subscription = registerCodingAgentAttentionNotifications({ threads, send, isCanonicalThread: async () => true });
    const onEvents = vi.fn(), observer = threads.registerEventSink(onEvents);
    try {
      for (const outcome of ["failed", "completed"] as const) {
        send.mockClear(); onEvents.mockClear();
        const created = await threads.createThread(principal, { providerId: "codex", prompt: "Recover the run.", clientRequestId: `req_mixed_${outcome}` });
        const bytes = Buffer.from([
          requestKind === "approval" ? { type: "matrix.codex.approval.requested", approvalId: "appr_codex_11111111111111111111111111111111", correlationId: "corr_codex_22222222222222222222222222222222",
            title: "Approve", safeDescription: "Review", actionKind: "command", risk: "medium", allowedDecisions: ["approve"] }
            : { type: "matrix.codex.user_input.requested", requestId: "req_codex_33333333333333333333333333333333", correlationId: "corr_codex_44444444444444444444444444444444", title: "Question", safeDescription: "Need input",
              questions: [{ questionId: "question_mixed", header: "Choice", question: "Which?", allowOther: true, secret: false }] },
          { type: `turn.${outcome}`, ...(outcome === "failed" ? { error: { message: "private provider detail" } } : {}) },
        ].map(record => JSON.stringify(record)).join("\n") + "\n");
        const input = { store: threads, principal, threadId: created.snapshot.thread.id, sessionId: "sess_mixed", offset: 0,
          occurredAt: now.toISOString(), bytes, consumedBytes: bytes.length };
        expect((await ingestCodexTranscript(input)).terminal).toBe(true);
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(onEvents).toHaveBeenCalledWith(expect.objectContaining({ events: expect.arrayContaining([
          expect.objectContaining({ type: requestKind === "approval" ? "approval.requested" : "user_input.requested" }),
          expect.objectContaining({ type: "thread.completed" }),
        ]) }));
        expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ownerId: principal.userId,
          text: outcome === "failed" ? "Agent run needs attention." : "Agent run completed.",
          metadata: { category: "agent", threadId: created.snapshot.thread.id } }));
        await ingestCodexTranscript(input); await new Promise<void>(resolve => setImmediate(resolve));
        expect(send).toHaveBeenCalledTimes(1);
      }
    } finally { observer.dispose(); subscription.dispose(); await threads.shutdownTurns(); await rm(homePath, { recursive: true, force: true }); }
  });

  it.each([completedProvider, failedProvider])("keeps disabled canonical terminal notifications disabled", async factory => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-a6-canonical-disabled-"));
    const threads = createCodingAgentThreadStore({ homePath, now: () => now, providers: [factory()] });
    const send = vi.fn<(reply: ChannelReply) => Promise<void>>().mockResolvedValue(undefined);
    const subscription = registerCodingAgentAttentionNotifications({ threads, send,
      isCanonicalThread: async () => true, preferences: { isAttentionPushEnabled: async () => false } });
    try {
      await threads.createThread(principal, { providerId: "codex", prompt: "Run the task.", clientRequestId: "req_terminal_disabled" });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(send).not.toHaveBeenCalled();
    } finally { subscription.dispose(); await threads.shutdownTurns(); await rm(homePath, { recursive: true, force: true }); }
  });

  it("deduplicates repeated attention notifications for the same owner thread and kind within the notification window", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-coding-agent-attention-notifications-"));
    const send = vi.fn<(reply: ChannelReply) => Promise<void>>().mockResolvedValue(undefined);
    const threads = createCodingAgentThreadStore({
      homePath,
      now: () => now,
      providers: [repeatedApprovalProvider()],
    });
    const subscription = registerCodingAgentAttentionNotifications({
      threads,
      send,
      now: () => 1_000,
      dedupeWindowMs: 60_000,
    });

    const created = await threads.createThread(principal, {
      providerId: "codex",
      prompt: "Review the next command.",
      clientRequestId: "req_attention_dedupe",
    });
    await threads.submitApproval(principal, created.snapshot.thread.id, "appr_safe_action", {
      decision: "approve",
      correlationId: "corr_safe_action",
      clientRequestId: "req_attention_dedupe_approval",
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      ownerId: principal.userId,
      text: "Agent needs approval.",
      metadata: {
        category: "agent",
        threadId: created.snapshot.thread.id,
      },
    }));

    subscription.dispose();
  });

  it("allows a repeated attention notification after the dedupe window expires", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-coding-agent-attention-notifications-"));
    let currentTime = 1_000;
    const send = vi.fn<(reply: ChannelReply) => Promise<void>>().mockResolvedValue(undefined);
    const threads = createCodingAgentThreadStore({
      homePath,
      now: () => now,
      providers: [repeatedApprovalProvider()],
    });
    const subscription = registerCodingAgentAttentionNotifications({
      threads,
      send,
      now: () => currentTime,
      dedupeWindowMs: 60_000,
    });

    const created = await threads.createThread(principal, {
      providerId: "codex",
      prompt: "Review the next command.",
      clientRequestId: "req_attention_dedupe_expiry",
    });
    currentTime += 61_000;
    await threads.submitApproval(principal, created.snapshot.thread.id, "appr_safe_action", {
      decision: "approve",
      correlationId: "corr_safe_action",
      clientRequestId: "req_attention_dedupe_expiry_approval",
    });

    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({
      ownerId: principal.userId,
      text: "Agent needs approval.",
      metadata: {
        category: "agent",
        threadId: created.snapshot.thread.id,
      },
    }));

    subscription.dispose();
  });

  it("honors owner notification preferences before sending attention push payloads", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-coding-agent-attention-notifications-"));
    const send = vi.fn<(reply: ChannelReply) => Promise<void>>().mockResolvedValue(undefined);
    const threads = createCodingAgentThreadStore({
      homePath,
      now: () => now,
      providers: [approvalProvider()],
    });
    const subscription = registerCodingAgentAttentionNotifications({
      threads,
      send,
      preferences: {
        isAttentionPushEnabled: async ({ ownerId, kind }) => ownerId !== principal.userId || kind !== "approval",
      },
    });

    await threads.createThread(principal, {
      providerId: "codex",
      prompt: "Review the next command.",
      clientRequestId: "req_attention_preferences",
    });

    expect(send).not.toHaveBeenCalled();

    subscription.dispose();
  });

  it("does not consume dedupe state when preferences skip an attention notification", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-coding-agent-attention-notifications-"));
    let enabled = false;
    const send = vi.fn<(reply: ChannelReply) => Promise<void>>().mockResolvedValue(undefined);
    const threads = createCodingAgentThreadStore({
      homePath,
      now: () => now,
      providers: [repeatedApprovalProvider()],
    });
    const subscription = registerCodingAgentAttentionNotifications({
      threads,
      send,
      now: () => 1_000,
      dedupeWindowMs: 60_000,
      preferences: {
        isAttentionPushEnabled: async () => enabled,
      },
    });

    const created = await threads.createThread(principal, {
      providerId: "codex",
      prompt: "Review the next command.",
      clientRequestId: "req_attention_preferences_dedupe",
    });
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();

    enabled = true;
    await threads.submitApproval(principal, created.snapshot.thread.id, "appr_safe_action", {
      decision: "approve",
      correlationId: "corr_safe_action",
      clientRequestId: "req_attention_preferences_dedupe_approval",
    });
    await Promise.resolve();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      ownerId: principal.userId,
      text: "Agent needs approval.",
      metadata: {
        category: "agent",
        threadId: created.snapshot.thread.id,
      },
    }));

    subscription.dispose();
  });
});
