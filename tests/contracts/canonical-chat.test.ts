import { describe, expect, it } from "vitest";
import {
  CanonicalChatMessageSchema,
  CanonicalChatInspectorProjectionSchema,
  CanonicalChatInvocationSchema,
  CanonicalChatResourceReferenceSchema,
  CanonicalChatRunActivitySchema,
  CanonicalChatSafeErrorSchema,
  CanonicalChatRunSchema,
  CanonicalChatSchema,
  CanonicalChatTurnSchema,
  CanonicalProviderDriverDescriptorSchema,
  CanonicalProviderInstanceDescriptorSchema,
} from "../../packages/contracts/src/index.js";

const now = "2026-08-25T00:00:00.000Z";

describe("canonical Chat contracts", () => {
  it("parses one complete Chat, Turn, Run, and message without exposing runtime internals", () => {
    const chat = CanonicalChatSchema.parse({
      id: "chat_demo",
      ownerScope: { type: "personal", ownerId: "user_demo" },
      title: "Canonical contracts",
      lifecycle: "active",
      attention: "none",
      revision: 1,
      messageCount: 1,
      lastMessagePreview: "Freeze the shared contracts.",
      createdAt: now,
      updatedAt: now,
    });
    const turn = CanonicalChatTurnSchema.parse({
      id: "cturn_demo",
      chatId: chat.id,
      clientRequestId: "req_demo",
      baseMessageSeq: 0,
      inputMessageId: "msg_demo",
      status: "completed",
      createdAt: now,
      updatedAt: now,
    });
    const run = CanonicalChatRunSchema.parse({
      id: "run_demo",
      chatId: chat.id,
      turnId: turn.id,
      attempt: 1,
      selection: { instanceId: "codex_primary", model: "gpt-5.6-sol" },
      status: "completed",
      outcome: "completed",
      historyBoundarySeq: 0,
      capabilitySnapshotRevision: "catalog_1",
      createdAt: now,
      updatedAt: now,
    });
    const message = CanonicalChatMessageSchema.parse({
      id: "msg_demo",
      chatId: chat.id,
      seq: 1,
      role: "user",
      state: "committed",
      turnId: turn.id,
      parts: [{ type: "text", text: "Freeze the shared contracts." }],
      createdAt: now,
    });

    expect({ chat: chat.id, turn: turn.id, run: run.id, message: message.id }).toEqual({
      chat: "chat_demo",
      turn: "cturn_demo",
      run: "run_demo",
      message: "msg_demo",
    });
    expect(CanonicalChatRunSchema.safeParse({
      ...run,
      primaryWorkspaceRoot: "/Users/yuhan/matrix-os",
      providerState: { sessionId: "secret" },
    }).success).toBe(false);
  });

  it("normalizes message parts and Run activity while rejecting raw provider errors", () => {
    const message = CanonicalChatMessageSchema.parse({
      id: "msg_assistant",
      chatId: "chat_demo",
      seq: 2,
      role: "assistant",
      state: "committed",
      turnId: "cturn_demo",
      runId: "run_demo",
      parts: [
        { type: "text", text: "Updated the contract." },
        { type: "tool_request", toolCallId: "tool_1", name: "Read", label: "Read the contract" },
        { type: "tool_result", toolCallId: "tool_1", outcome: "success", text: "Contract loaded.", truncated: false },
        { type: "attachment_reference", attachmentId: "attachment_1", kind: "file", label: "spec.md" },
        {
          type: "approval_request",
          approvalId: "approval_1",
          title: "Apply changes",
          description: "Allow the contract edit.",
          risk: "low",
          allowedDecisions: ["approve", "decline"],
        },
        { type: "approval_result", approvalId: "approval_1", decision: "approve" },
        { type: "status", tone: "success", label: "Contract updated" },
        { type: "summary", text: "Canonical schemas are ready.", source: "assistant" },
      ],
      createdAt: now,
    });
    const activity = CanonicalChatRunActivitySchema.parse({
      id: "activity_1",
      chatId: "chat_demo",
      runId: "run_demo",
      occurredAt: now,
      type: "tool.progress",
      toolCallId: "tool_1",
      label: "Reading contract",
      status: "running",
    });

    expect(message.parts).toHaveLength(8);
    expect(activity.type).toBe("tool.progress");
    expect(CanonicalChatRunActivitySchema.safeParse({
      ...activity,
      providerPayload: { stderr: "secret" },
    }).success).toBe(false);
    expect(CanonicalChatSafeErrorSchema.safeParse({
      code: "run_failed",
      safeMessage: "Postgres failed at /home/matrix/private",
      retryable: false,
    }).success).toBe(false);
    expect(CanonicalChatSafeErrorSchema.safeParse({
      code: "run_failed",
      safeMessage: "OpenAI returned an Anthropic provider error",
      retryable: false,
    }).success).toBe(false);
  });

  it("describes a Driver and Instance whose controls are capability-derived", () => {
    const driver = CanonicalProviderDriverDescriptorSchema.parse({
      kind: "codex",
      displayName: "Codex",
      adapterVersion: "1.0.0",
      capabilityClass: "coding_agent",
    });
    const instance = CanonicalProviderInstanceDescriptorSchema.parse({
      id: "codex_primary",
      driverKind: driver.kind,
      displayName: "Codex — primary account",
      availability: "available",
      workspaceRequirement: "project_optional",
      catalogRevision: "catalog_1",
      models: [{
        id: "gpt-5.6-sol",
        displayName: "GPT-5.6-Sol",
        availability: "available",
        capabilities: ["reasoning", "tools"],
        contextWindow: 200_000,
        supportsVision: true,
        supportsToolUse: true,
      }],
      options: [{
        id: "effort",
        label: "Reasoning",
        kind: "enum",
        values: [
          { value: "low", label: "Low" },
          { value: "high", label: "High" },
        ],
        defaultValue: "low",
        placement: "composer",
      }],
      skills: [{
        id: "review",
        displayName: "Review",
        description: "Review the selected changes.",
        invocation: "/review",
      }],
      commands: [],
      supports: {
        rootChat: true,
        resume: true,
        cancellation: true,
        attachments: ["file", "image"],
        tools: ["read", "write"],
        approvals: true,
        userInput: true,
        worktrees: "optional",
        interactionModes: ["default", "plan"],
        permissionModes: ["supervised", "full_access"],
      },
      defaultSelection: {
        instanceId: "codex_primary",
        model: "gpt-5.6-sol",
        options: [{ id: "effort", value: "low" }],
      },
    });

    expect(instance.supports.interactionModes).toEqual(["default", "plan"]);
    expect(CanonicalProviderInstanceDescriptorSchema.safeParse({
      ...instance,
      defaultSelection: { ...instance.defaultSelection, instanceId: "claude_primary" },
    }).success).toBe(false);
    expect(CanonicalProviderInstanceDescriptorSchema.safeParse({
      ...instance,
      credentials: { token: "secret" },
    }).success).toBe(false);
  });

  it("projects typed slash invocations, @ resources, and inspector state without paths", () => {
    const invocation = CanonicalChatInvocationSchema.parse({
      kind: "skill",
      descriptorId: "review",
      invocation: "/review",
      arguments: "focus on auth boundaries",
    });
    const file = CanonicalChatResourceReferenceSchema.parse({
      kind: "file",
      id: "src.gateway.routes",
      label: "packages/gateway/src/routes.ts",
      revision: "blob_1",
    });
    const inspector = CanonicalChatInspectorProjectionSchema.parse({
      chatId: "chat_demo",
      context: {
        project: {
          projectId: "matrix-os",
          name: "Matrix OS",
          kind: "github",
          repositoryLabel: "HamedMP/matrix-os",
          status: "ready",
        },
        executionRoot: { kind: "project", projectId: "matrix-os" },
      },
      run: {
        runId: "run_demo",
        status: "running",
        driverKind: "codex",
        instanceId: "codex_primary",
        model: "gpt-5.6-sol",
        startedAt: now,
      },
      files: [file],
      terminals: [{ kind: "terminal_session", id: "term_main", label: "main" }],
      changes: {
        availability: "available",
        turnId: "cturn_demo",
        changedFileCount: 1,
        additions: 20,
        deletions: 1,
        partial: false,
        files: [{ resource: file, changeKind: "updated" }],
      },
    });

    expect(invocation.kind).toBe("skill");
    expect(inspector.changes.availability).toBe("available");
    expect(CanonicalChatResourceReferenceSchema.safeParse({
      kind: "file",
      id: "/Users/yuhan/private.ts",
      label: "private.ts",
    }).success).toBe(false);
    expect(CanonicalChatInspectorProjectionSchema.safeParse({
      ...inspector,
      primaryWorkspaceRoot: "/Users/yuhan/matrix-os",
    }).success).toBe(false);
  });

  it("enforces independent UTF-8 byte and collection-count caps", () => {
    const baseMessage = {
      id: "msg_bounds",
      chatId: "chat_demo",
      seq: 1,
      role: "user" as const,
      state: "committed" as const,
      parts: [{ type: "text" as const, text: "bounded" }],
      createdAt: now,
    };
    const cjkWithinCharacterLimitButOverByteLimit = "界".repeat(25_000);

    expect(CanonicalChatMessageSchema.safeParse({
      ...baseMessage,
      parts: [{ type: "text", text: cjkWithinCharacterLimitButOverByteLimit }],
    }).success).toBe(false);
    expect(CanonicalChatMessageSchema.safeParse({
      ...baseMessage,
      parts: Array.from({ length: 65 }, () => ({ type: "text", text: "part" })),
    }).success).toBe(false);

    const model = {
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6-Sol",
      availability: "available" as const,
      capabilities: ["reasoning" as const],
      supportsVision: true,
      supportsToolUse: true,
    };
    expect(CanonicalProviderInstanceDescriptorSchema.safeParse({
      id: "codex_bounds",
      driverKind: "codex",
      displayName: "Codex bounds",
      availability: "available",
      workspaceRequirement: "none",
      catalogRevision: "catalog_bounds",
      models: Array.from({ length: 129 }, (_, index) => ({ ...model, id: `model-${index}` })),
      options: [],
      skills: [],
      commands: [],
      supports: {
        rootChat: true,
        resume: true,
        cancellation: true,
        attachments: [],
        tools: [],
        approvals: true,
        userInput: true,
        worktrees: "none",
        interactionModes: [],
        permissionModes: [],
      },
    }).success).toBe(false);
  });
});
