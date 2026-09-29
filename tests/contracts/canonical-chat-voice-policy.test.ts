import { describe, expect, it } from "vitest";
import {
  CanonicalChatMessageSchema,
  CanonicalChatQueuedTurnSchema,
  CanonicalChatRunActivitySchema,
  CanonicalChatRunSchema,
  CanonicalCreateChatTurnRequestSchema,
  CanonicalProviderSupportSchema,
  CanonicalSubmitChatApprovalRequestSchema,
} from "../../packages/contracts/src/index.js";

const now = "2026-08-25T00:00:00.000Z";
const digest = "a".repeat(64);

const selection = { instanceId: "codex_default", model: "gpt-5.6-sol" };

function turnRequest(overrides: Record<string, unknown> = {}) {
  return {
    clientRequestId: "req_voice_turn",
    baseRevision: 0,
    parts: [{ type: "text", text: "send it" }],
    selection,
    interactionMode: "default",
    permissionMode: "supervised",
    ...overrides,
  };
}

function capabilitySnapshot(overrides: Record<string, unknown> = {}) {
  return {
    revision: "catalog_voice",
    rootChat: true,
    attachments: [],
    resources: [],
    tools: [],
    approvals: true,
    userInput: false,
    resume: true,
    cancellation: true,
    steering: "none",
    worktrees: "none",
    interactionModes: ["default"],
    permissionModes: ["supervised"],
    ...overrides,
  };
}

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: "run_voice_1",
    chatId: "chat_voice",
    turnId: "cturn_voice_1",
    attempt: 1,
    driverKind: "codex",
    instanceId: "codex_default",
    selection,
    interactionMode: "default",
    permissionMode: "supervised",
    status: "accepted",
    historyBoundarySeq: 0,
    capabilitySnapshot: capabilitySnapshot(),
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function providerSupport(overrides: Record<string, unknown> = {}) {
  return {
    rootChat: true,
    resume: true,
    cancellation: true,
    attachments: [],
    tools: [],
    approvals: true,
    userInput: false,
    worktrees: "none",
    resources: [],
    interactionModes: ["default"],
    permissionModes: ["supervised"],
    ...overrides,
  };
}

describe("canonical voice run policy contract", () => {
  it("accepts a bounded session-only policy on turn admission", () => {
    const parsed = CanonicalCreateChatTurnRequestSchema.parse(turnRequest({
      runPolicy: {
        memoryMode: "session_only",
        nativeCheckpointPolicy: "disposable",
        source: "voice",
        voiceSessionId: "vsession_1",
      },
    }));
    expect(parsed.runPolicy).toMatchObject({
      memoryMode: "session_only",
      nativeCheckpointPolicy: "disposable",
      source: "voice",
    });
  });

  it("accepts an ordinary typed policy and keeps runPolicy optional", () => {
    expect(CanonicalCreateChatTurnRequestSchema.parse(turnRequest()).runPolicy).toBeUndefined();
    const parsed = CanonicalCreateChatTurnRequestSchema.parse(turnRequest({
      runPolicy: {
        memoryMode: "ordinary",
        nativeCheckpointPolicy: "reusable",
        source: "typed",
      },
    }));
    expect(parsed.runPolicy?.memoryMode).toBe("ordinary");
  });

  it("rejects session-only policies that keep reusable native checkpoints or memory tools", () => {
    expect(CanonicalCreateChatTurnRequestSchema.safeParse(turnRequest({
      runPolicy: {
        memoryMode: "session_only",
        nativeCheckpointPolicy: "reusable",
        source: "voice",
      },
    })).success).toBe(false);
    expect(CanonicalCreateChatTurnRequestSchema.safeParse(turnRequest({
      runPolicy: {
        memoryMode: "session_only",
        nativeCheckpointPolicy: "disposable",
        source: "voice",
        memoryTools: ["memory_store"],
      },
    })).success).toBe(false);
  });

  it("rejects unknown keys and unbounded values inside runPolicy", () => {
    expect(CanonicalCreateChatTurnRequestSchema.safeParse(turnRequest({
      runPolicy: {
        memoryMode: "session_only",
        nativeCheckpointPolicy: "disposable",
        source: "voice",
        providerPayload: { leaked: "secret" },
      },
    })).success).toBe(false);
    expect(CanonicalCreateChatTurnRequestSchema.safeParse(turnRequest({
      runPolicy: {
        memoryMode: "ephemeral_forever",
        nativeCheckpointPolicy: "disposable",
        source: "voice",
      },
    })).success).toBe(false);
    expect(CanonicalCreateChatTurnRequestSchema.safeParse(turnRequest({
      runPolicy: {
        memoryMode: "ordinary",
        nativeCheckpointPolicy: "reusable",
        source: "voice",
        voiceSessionId: "../outside",
      },
    })).success).toBe(false);
  });

  it("surfaces runPolicy on queued turns and runs", () => {
    const policy = {
      memoryMode: "session_only" as const,
      nativeCheckpointPolicy: "disposable" as const,
      source: "voice" as const,
      voiceSessionId: "vsession_queued",
    };
    const queued = CanonicalChatQueuedTurnSchema.parse({
      id: "qturn_voice1",
      chatId: "chat_voice",
      clientRequestId: "req_queued_voice",
      position: 1,
      parts: [{ type: "text", text: "queued" }],
      selection,
      interactionMode: "default",
      permissionMode: "supervised",
      runPolicy: policy,
      createdAt: now,
      updatedAt: now,
    });
    expect(queued.runPolicy).toMatchObject({ memoryMode: "session_only" });
    const parsedRun = CanonicalChatRunSchema.parse(run({ runPolicy: policy }));
    expect(parsedRun.runPolicy).toMatchObject({ source: "voice" });
  });

  it("rejects queued turns with an invalid policy payload", () => {
    const queued = {
      id: "qturn_voice1",
      chatId: "chat_voice",
      clientRequestId: "req_queued_voice",
      position: 1,
      parts: [{ type: "text", text: "queued" }],
      selection,
      interactionMode: "default",
      permissionMode: "supervised",
      createdAt: now,
      updatedAt: now,
    };
    expect(CanonicalChatQueuedTurnSchema.safeParse({
      ...queued,
      runPolicy: { memoryMode: "session_only" },
    }).success).toBe(false);
    expect(CanonicalChatQueuedTurnSchema.safeParse({
      ...queued,
      runPolicy: "session_only",
    }).success).toBe(false);
  });
});

describe("canonical approval argument digest contract", () => {
  it("carries a normalized argument digest on approval proposals", () => {
    const message = CanonicalChatMessageSchema.parse({
      id: "msg_approval",
      chatId: "chat_voice",
      seq: 2,
      role: "assistant",
      state: "committed",
      parts: [{
        type: "approval_request",
        approvalId: "appr_1",
        title: "Send email",
        description: "Send the drafted email",
        risk: "high",
        argumentDigest: digest,
        allowedDecisions: ["approve", "decline"],
      }],
      createdAt: now,
    });
    const part = message.parts[0];
    expect(part.type === "approval_request" ? part.argumentDigest : undefined).toBe(digest);
  });

  it("carries the digest through requested and resolved run activities", () => {
    const requested = CanonicalChatRunActivitySchema.parse({
      id: "activity_req",
      chatId: "chat_voice",
      runId: "run_voice_1",
      occurredAt: now,
      type: "approval.requested",
      approvalId: "appr_1",
      title: "Send email",
      risk: "high",
      allowedDecisions: ["approve"],
      argumentDigest: digest,
    });
    expect(requested.type === "approval.requested" ? requested.argumentDigest : undefined).toBe(digest);
    const resolved = CanonicalChatRunActivitySchema.parse({
      id: "activity_res",
      chatId: "chat_voice",
      runId: "run_voice_1",
      occurredAt: now,
      type: "approval.resolved",
      approvalId: "appr_1",
      decision: "approve",
      argumentDigest: digest,
    });
    expect(resolved.type === "approval.resolved" ? resolved.argumentDigest : undefined).toBe(digest);
  });

  it("rejects malformed digests on the proposal and the submission", () => {
    expect(CanonicalChatRunActivitySchema.safeParse({
      id: "activity_req",
      chatId: "chat_voice",
      runId: "run_voice_1",
      occurredAt: now,
      type: "approval.requested",
      approvalId: "appr_1",
      title: "Send email",
      risk: "high",
      allowedDecisions: ["approve"],
      argumentDigest: "not-a-digest",
    }).success).toBe(false);
    expect(CanonicalSubmitChatApprovalRequestSchema.safeParse({
      clientRequestId: "req_approval_decision",
      decision: "approve",
      argumentDigest: digest.toUpperCase(),
    }).success).toBe(false);
    expect(CanonicalSubmitChatApprovalRequestSchema.parse({
      clientRequestId: "req_approval_decision",
      decision: "approve",
      argumentDigest: digest,
    }).argumentDigest).toBe(digest);
  });
});

describe("canonical action capability contract", () => {
  it("declares approval binding and cancellation granularity on provider support", () => {
    const supports = CanonicalProviderSupportSchema.parse(providerSupport({
      approvalBinding: "argument_digest",
      cancellation: "tool",
    }));
    expect(supports.approvalBinding).toBe("argument_digest");
    expect(supports.cancellation).toBe("tool");
  });

  it("keeps the legacy boolean cancellation flag valid and fails closed by default", () => {
    expect(CanonicalProviderSupportSchema.parse(providerSupport()).cancellation).toBe(true);
    expect(CanonicalProviderSupportSchema.parse(providerSupport({ cancellation: false })).cancellation)
      .toBe(false);
    expect(CanonicalProviderSupportSchema.parse(providerSupport({ cancellation: "run" })).cancellation)
      .toBe("run");
    expect(CanonicalProviderSupportSchema.parse(providerSupport({ cancellation: "none" })).cancellation)
      .toBe("none");
    expect(CanonicalProviderSupportSchema.safeParse(providerSupport({ cancellation: "maybe" })).success)
      .toBe(false);
    expect(CanonicalProviderSupportSchema.parse(providerSupport()).approvalBinding).toBeUndefined();
    expect(CanonicalProviderSupportSchema.safeParse(providerSupport({ approvalBinding: "md5" })).success)
      .toBe(false);
  });

  it("rejects an approval binding claim from a provider without approvals", () => {
    expect(CanonicalProviderSupportSchema.safeParse(providerSupport({
      approvals: false,
      approvalBinding: "argument_digest",
    })).success).toBe(false);
  });

  it("rejects unknown capability keys and snapshots truthful fields on the run", () => {
    expect(CanonicalProviderSupportSchema.safeParse(providerSupport({ toolCancel: true })).success)
      .toBe(false);
    const parsed = CanonicalChatRunSchema.parse(run({
      capabilitySnapshot: capabilitySnapshot({
        approvalBinding: "argument_digest",
        cancellation: "tool",
      }),
    }));
    expect(parsed.capabilitySnapshot.approvalBinding).toBe("argument_digest");
    expect(parsed.capabilitySnapshot.cancellation).toBe("tool");
    expect(CanonicalChatRunSchema.safeParse(run({
      capabilitySnapshot: capabilitySnapshot({ approvalBinding: "sha1" }),
    })).success).toBe(false);
    // A persisted snapshot from before the capability fields existed must still parse.
    const legacy = CanonicalChatRunSchema.parse(run({
      capabilitySnapshot: capabilitySnapshot({ cancellation: true }),
    }));
    expect(legacy.capabilitySnapshot.approvalBinding).toBeUndefined();
  });

  it("rejects a digest-binding snapshot without approval support", () => {
    expect(CanonicalChatRunSchema.safeParse(run({
      capabilitySnapshot: capabilitySnapshot({
        approvals: false,
        approvalBinding: "argument_digest",
      }),
    })).success).toBe(false);
  });
});
