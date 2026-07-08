import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentThreadEventSchema } from "@matrix-os/contracts";
import { registerCodingAgentAttentionNotifications } from "../../packages/gateway/src/coding-agents/attention-notifications.js";
import {
  createCodingAgentThreadStore,
  type CodingAgentProviderAdapter,
} from "../../packages/gateway/src/coding-agents/thread-store.js";
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
