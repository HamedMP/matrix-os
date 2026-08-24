import type {
  CanonicalChatRun,
  CanonicalChatRunActivity,
  CanonicalChatSnapshot,
  CanonicalProviderCatalog,
} from "../../../packages/contracts/src/index.js";

export const CANONICAL_CHAT_FIXTURE_STATES = [
  "idle",
  "running",
  "approval_required",
  "input_required",
  "failed",
  "completed",
] as const;

export type CanonicalChatFixtureState = typeof CANONICAL_CHAT_FIXTURE_STATES[number];

export interface CanonicalChatFixture {
  snapshot: CanonicalChatSnapshot;
  providerCatalog: CanonicalProviderCatalog;
}

const now = "2026-08-25T00:00:00.000Z";

function runStatus(state: CanonicalChatFixtureState): CanonicalChatRun["status"] | undefined {
  if (state === "idle") return undefined;
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

function fixtureCatalog(): CanonicalProviderCatalog {
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
      availability: "available",
      workspaceRequirement: "project_optional",
      catalogRevision: "catalog_fixture_1",
      models: [{
        id: "gpt-5.6-sol",
        displayName: "GPT-5.6-Sol",
        availability: "available",
        capabilities: ["reasoning", "tools"],
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
        interactionModes: ["default", "plan"],
        permissionModes: ["supervised", "full_access"],
      },
      defaultSelection: { instanceId: "codex_fixture", model: "gpt-5.6-sol" },
    }],
  };
}

export function createCanonicalChatFixture(state: CanonicalChatFixtureState): CanonicalChatFixture {
  const chatId = `chat_fixture_${state}`;
  const status = runStatus(state);
  const turnId = `cturn_fixture_${state}`;
  const runId = `run_fixture_${state}`;
  const active = status === "running" || status === "waiting_for_approval" || status === "waiting_for_input";
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
    selection: { instanceId: "codex_fixture", model: "gpt-5.6-sol" },
    status,
    ...(status === "completed" || status === "failed" ? { outcome: status } : {}),
    historyBoundarySeq: 0,
    capabilitySnapshotRevision: "catalog_fixture_1",
    createdAt: now,
    updatedAt: now,
  }];
  const snapshot: CanonicalChatSnapshot = {
    chat: {
      id: chatId,
      ownerScope: { type: "personal", ownerId: "user_fixture" },
      title: `${state} Chat`,
      lifecycle: "active",
      attention: attention(state),
      revision: 1,
      messageCount: 1,
      lastMessagePreview: "Build the canonical Chat contract.",
      currentSelection: { instanceId: "codex_fixture", model: "gpt-5.6-sol" },
      project,
      ...(status === undefined ? {} : {
        providerBinding: { driverKind: "codex", instanceId: "codex_fixture", lockedAtTurnId: turnId },
      }),
      ...(active ? { activeRun: { runId, turnId, status } } : {}),
      createdAt: now,
      updatedAt: now,
    },
    messages: [{
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
      status: status === "completed" || status === "failed" ? status : "running",
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
          ...((status === "completed" || status === "failed") ? { completedAt: now } : {}),
        },
      }),
      files: [],
      terminals: [],
      changes: { availability: "unavailable", reason: status === undefined ? "not_ready" : "not_supported" },
    },
  };

  return { snapshot, providerCatalog: fixtureCatalog() };
}
