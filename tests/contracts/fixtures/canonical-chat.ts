import type {
  CanonicalChatRun,
  CanonicalChatRunActivity,
  CanonicalChatInspectorProjection,
  CanonicalChatMessagePart,
  CanonicalChatSnapshot,
  CanonicalProviderCatalog,
} from "../../../packages/contracts/src/index.js";

export const CANONICAL_CHAT_FIXTURE_STATES = [
  "idle",
  "accepted",
  "running",
  "approval_required",
  "input_required",
  "failed",
  "completed",
  "aborted",
  "archived",
] as const;

export const CANONICAL_PROVIDER_FIXTURE_AVAILABILITIES = [
  "available",
  "setup_required",
  "auth_required",
  "unavailable",
] as const;

export const CANONICAL_INSPECTOR_FIXTURE_STATES = [
  "unavailable",
  "available",
  "partial",
] as const;

export type CanonicalChatFixtureState = typeof CANONICAL_CHAT_FIXTURE_STATES[number];

export interface CanonicalChatFixture {
  snapshot: CanonicalChatSnapshot;
  providerCatalog: CanonicalProviderCatalog;
}

const now = "2026-08-25T00:00:00.000Z";

function runStatus(state: CanonicalChatFixtureState): CanonicalChatRun["status"] | undefined {
  if (state === "idle") return undefined;
  if (state === "archived") return "completed";
  if (state === "approval_required") return "waiting_for_approval";
  if (state === "input_required") return "waiting_for_input";
  return state;
}

function attention(state: CanonicalChatFixtureState): CanonicalChatSnapshot["chat"]["attention"] {
  if (state === "approval_required" || state === "input_required" || state === "failed") return state;
  return "none";
}

function activityFor(
  state: CanonicalChatFixtureState,
  chatId: string,
): CanonicalChatRunActivity[] {
  const status = runStatus(state);
  if (status === undefined) return [];
  return [{
    id: `activity_${state}`,
    chatId,
    runId: `run_fixture_${state}`,
    occurredAt: now,
    type: "run.status",
    status,
  }];
}

export function createCanonicalProviderCatalogFixture(
  availability: typeof CANONICAL_PROVIDER_FIXTURE_AVAILABILITIES[number] = "available",
): CanonicalProviderCatalog {
  return {
    revision: "catalog_fixture_1",
    drivers: [{
      kind: "codex",
      displayName: "Codex",
      adapterVersion: "1.0.0",
      capabilityClass: "coding_agent",
    }],
    instances: [{
      id: "codex_fixture",
      driverKind: "codex",
      displayName: "Codex fixture",
      availability,
      workspaceRequirement: "project_optional",
      catalogRevision: "catalog_fixture_1",
      models: [{
        id: "gpt-5.6-sol",
        displayName: "GPT-5.6-Sol",
        availability: "available",
        capabilities: ["reasoning", "tools", "vision"],
        supportsVision: true,
        supportsToolUse: true,
      }],
      options: [],
      skills: [],
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
        resources: ["file", "folder", "project", "task", "app", "terminal_session"],
        interactionModes: ["default", "plan"],
        permissionModes: ["supervised", "full_access"],
      },
      ...(availability === "available"
        ? { defaultSelection: { instanceId: "codex_fixture", model: "gpt-5.6-sol" } }
        : {}),
    }],
  };
}

export function createCanonicalMessagePartsFixture(): CanonicalChatMessagePart[] {
  return [
    { type: "text", text: "Build the canonical Chat contract." },
    { type: "tool_request", toolCallId: "tool_fixture", name: "Read", label: "Read the contract" },
    { type: "tool_result", toolCallId: "tool_fixture", outcome: "success", text: "Contract loaded.", truncated: false },
    { type: "attachment_reference", attachmentId: "attachment_fixture", kind: "file", label: "spec.md" },
    {
      type: "approval_request",
      approvalId: "approval_fixture",
      title: "Apply changes",
      description: "Allow the contract edit.",
      risk: "low",
      allowedDecisions: ["approve", "decline"],
    },
    { type: "approval_result", approvalId: "approval_fixture", decision: "approve" },
    { type: "status", tone: "success", label: "Contract updated" },
    { type: "summary", text: "Canonical schemas are ready.", source: "assistant" },
    {
      type: "invocation_reference",
      invocation: { kind: "skill", descriptorId: "review", invocation: "/review" },
    },
    {
      type: "resource_reference",
      resource: { kind: "file", id: "src.gateway.routes", label: "packages/gateway/src/routes.ts" },
    },
  ];
}

export function createCanonicalRunActivitiesFixture(): CanonicalChatRunActivity[] {
  const base = { chatId: "chat_fixture_activity", runId: "run_fixture_activity", occurredAt: now };
  return [
    { ...base, id: "activity_run", type: "run.status", status: "running" },
    { ...base, id: "activity_turn", type: "turn.status", turnId: "cturn_fixture_activity", status: "running" },
    { ...base, id: "activity_delta", type: "assistant.delta", messageId: "msg_fixture_activity", delta: "Working." },
    { ...base, id: "activity_output", type: "tool.output", toolCallId: "tool_fixture", text: "Tool output ready.", truncated: false },
    { ...base, id: "activity_tool", type: "tool.progress", toolCallId: "tool_fixture", label: "Reading", status: "running" },
    { ...base, id: "activity_review", type: "review.ready", reviewId: "review_fixture", summary: { changedFileCount: 1, additions: 2, deletions: 0, partial: false } },
    { ...base, id: "activity_terminal", type: "terminal.bound", terminalSessionId: "terminal_fixture" },
    { ...base, id: "activity_error", type: "run.error", error: { code: "run_failed", safeMessage: "The Run stopped safely.", retryable: true, recoveryActions: ["retry"] } },
    { ...base, id: "activity_approval_request", type: "approval.requested", approvalId: "approval_fixture", title: "Apply changes", risk: "low" },
    { ...base, id: "activity_approval_result", type: "approval.resolved", approvalId: "approval_fixture", decision: "approve" },
    { ...base, id: "activity_input_request", type: "input.requested", requestId: "request_fixture", title: "Choose an option" },
    { ...base, id: "activity_input_result", type: "input.resolved", requestId: "request_fixture" },
    { ...base, id: "activity_resource", type: "resource.changed", resourceId: "resource_fixture", resourceKind: "file", changeKind: "updated" },
    { ...base, id: "activity_message", type: "message.committed", messageId: "msg_fixture_activity", seq: 1 },
  ];
}

export function createCanonicalInspectorFixture(
  state: typeof CANONICAL_INSPECTOR_FIXTURE_STATES[number],
): CanonicalChatInspectorProjection {
  const project = {
    projectId: "matrix-os",
    name: "Matrix OS",
    kind: "github" as const,
    repositoryLabel: "HamedMP/matrix-os",
    status: "ready" as const,
  };
  return {
    chatId: "chat_fixture_inspector",
    context: { project, executionRoot: { kind: "project", projectId: project.projectId } },
    files: [{ kind: "file", id: "src.gateway.routes", label: "packages/gateway/src/routes.ts" }],
    terminals: [{ kind: "terminal_session", id: "terminal_fixture", label: "main" }],
    changes: state === "unavailable"
      ? { availability: "unavailable", reason: "not_ready" }
      : {
          availability: "available",
          turnId: "cturn_fixture_inspector",
          changedFileCount: 1,
          additions: 20,
          deletions: 1,
          partial: state === "partial",
          files: [{
            resource: { kind: "file", id: "src.gateway.routes", label: "packages/gateway/src/routes.ts" },
            changeKind: "updated",
          }],
        },
  };
}

export function createCanonicalChatFixture(state: CanonicalChatFixtureState): CanonicalChatFixture {
  const chatId = `chat_fixture_${state}`;
  const status = runStatus(state);
  const turnId = `cturn_fixture_${state}`;
  const runId = `run_fixture_${state}`;
  const active = status === "accepted" || status === "running"
    || status === "waiting_for_approval" || status === "waiting_for_input";
  const project = {
    projectId: "matrix-os",
    name: "Matrix OS",
    kind: "github" as const,
    repositoryLabel: "HamedMP/matrix-os",
    status: "ready" as const,
  };
  const runs: CanonicalChatRun[] = status === undefined ? [] : [{
    id: runId,
    chatId,
    turnId,
    attempt: 1,
    driverKind: "codex",
    instanceId: "codex_fixture",
    selection: { instanceId: "codex_fixture", model: "gpt-5.6-sol" },
    interactionMode: "default",
    permissionMode: "supervised",
    executionRoot: { kind: "project", projectId: project.projectId },
    status,
    ...(status === "completed" || status === "failed" || status === "aborted" ? { outcome: status } : {}),
    ...(status === "accepted" ? {} : { startedAt: now }),
    ...(status === "completed" || status === "failed" || status === "aborted" ? { completedAt: now } : {}),
    historyBoundarySeq: 0,
    capabilitySnapshot: {
      revision: "catalog_fixture_1",
      rootChat: true,
      attachments: ["file", "image"],
      resources: ["file", "folder", "project", "task", "app", "terminal_session"],
      tools: ["read", "write"],
      approvals: true,
      userInput: true,
      resume: true,
      cancellation: true,
      worktrees: "optional",
      interactionModes: ["default", "plan"],
      permissionModes: ["supervised", "full_access"],
    },
    createdAt: now,
    updatedAt: now,
  }];
  const snapshot: CanonicalChatSnapshot = {
    chat: {
      id: chatId,
      ownerScope: { type: "personal", ownerId: "user_fixture" },
      title: `${state} Chat`,
      lifecycle: state === "archived" ? "archived" : "active",
      attention: attention(state),
      revision: 1,
      messageCount: state === "idle" ? 0 : 1,
      ...(state === "idle" ? {} : { lastMessagePreview: "Build the canonical Chat contract." }),
      currentSelection: { instanceId: "codex_fixture", model: "gpt-5.6-sol" },
      project,
      ...(status === undefined ? {} : {
        providerBinding: { driverKind: "codex", instanceId: "codex_fixture", lockedAtTurnId: turnId },
      }),
      ...(active ? { activeRun: { runId, turnId, status } } : {}),
      createdAt: now,
      updatedAt: now,
    },
    messages: state === "idle" ? [] : [{
      id: `msg_fixture_${state}`,
      chatId,
      seq: 1,
      role: "user",
      state: "committed",
      ...(status === undefined ? {} : { turnId }),
      parts: [{ type: "text", text: "Build the canonical Chat contract." }],
      createdAt: now,
    }],
    turns: status === undefined ? [] : [{
      id: turnId,
      chatId,
      clientRequestId: `req_fixture_${state}`,
      baseMessageSeq: 0,
      inputMessageId: `msg_fixture_${state}`,
      status: status === "completed" || status === "failed" || status === "aborted"
        ? status
        : status === "accepted" ? "accepted" : "running",
      createdAt: now,
      updatedAt: now,
    }],
    runs,
    activities: activityFor(state, chatId),
    inspector: {
      chatId,
      context: {
        project,
        executionRoot: { kind: "project", projectId: project.projectId },
      },
      ...(status === undefined ? {} : {
        run: {
          runId,
          status,
          driverKind: "codex",
          instanceId: "codex_fixture",
          model: "gpt-5.6-sol",
          startedAt: now,
          ...((status === "completed" || status === "failed" || status === "aborted") ? { completedAt: now } : {}),
        },
      }),
      files: [],
      terminals: [],
      changes: { availability: "unavailable", reason: status === undefined ? "not_ready" : "not_supported" },
    },
  };

  return { snapshot, providerCatalog: createCanonicalProviderCatalogFixture() };
}
