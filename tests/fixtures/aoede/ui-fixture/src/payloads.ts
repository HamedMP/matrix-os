/**
 * Canned canonical payloads for the standalone Aoede fixture.
 *
 * Every object here is raw JSON data shaped to the authoritative contracts in
 * @matrix-os/contracts. The fixture backend re-parses each response through
 * its Zod schema before serving it, and tests/ui/aoede-fixture-payloads.test.ts
 * asserts the same — payload drift fails loudly instead of silently presenting
 * a broken panel.
 */
import type {
  AoedeBootstrapResponse,
  CanonicalChat,
  CanonicalChatDetailResponse,
  CanonicalChatMessage,
  CanonicalChatMessagePart,
  CanonicalChatRun,
  CanonicalChatRunActivity,
  CanonicalChatTurn,
  CanonicalOperationView,
  CanonicalProviderCatalog,
} from "@matrix-os/contracts";
import type { VoiceCapability } from "@matrix-os/contracts/voice-session";

export const FIXTURE_CHAT_ID = "chat_aoede_fixture";
export const FIXTURE_OWNER_ID = "user_aoede_fixture";
export const FIXTURE_SESSION_ID = "vs_aoede_fixture";
export const FIXTURE_INSTANCE_ID = "codex_fixture";
export const FIXTURE_MODEL = "gpt-5.6-sol";
export const FIXTURE_SCOPE = { kind: "workspace", id: "main", label: "Workspace" } as const;
export const FIXTURE_SELECTION = { instanceId: FIXTURE_INSTANCE_ID, model: FIXTURE_MODEL } as const;

const T0 = "2026-09-30T00:00:00.000Z";
const T1 = "2026-09-30T00:00:15.000Z";
const T2 = "2026-09-30T00:00:30.000Z";
const T3 = "2026-09-30T00:00:45.000Z";
const T4 = "2026-09-30T00:01:00.000Z";

/** SHA-256-shaped digests (64 lowercase hex) for argument bindings. */
export const DIGEST_APPLY = "ab".repeat(32);
export const DIGEST_OPEN = "cd".repeat(32);
export const DIGEST_SEARCH = "ef".repeat(32);
export const DIGEST_UNKNOWN = "12".repeat(32);
export const DIGEST_RUNNING = "34".repeat(32);
const EXECUTION_ROOT_FINGERPRINT = "56".repeat(32);
const FILE_SHA = "78".repeat(32);

export function fixtureCapability(overrides: Partial<VoiceCapability> = {}): VoiceCapability {
  return {
    contractVersion: 1,
    status: "available",
    surface: "web_canvas",
    transportModes: ["relayed_websocket"],
    turnModes: ["hands_free", "push_to_talk"],
    supportsInterruption: true,
    resume: "delivery_aware",
    sessionOnly: "unsupported",
    actionMode: "canonical_actions",
    actionCancellation: "run",
    supportsInputSelection: true,
    supportsOutputSelection: true,
    ...overrides,
  };
}

export function fixtureBootstrap(overrides: Partial<AoedeBootstrapResponse> = {}): AoedeBootstrapResponse {
  return {
    chatId: FIXTURE_CHAT_ID,
    scope: { ...FIXTURE_SCOPE },
    selection: { ...FIXTURE_SELECTION },
    capability: fixtureCapability(),
    ...overrides,
  };
}

export function fixtureChat(overrides: Partial<CanonicalChat> = {}): CanonicalChat {
  return {
    id: FIXTURE_CHAT_ID,
    ownerScope: { type: "personal", ownerId: FIXTURE_OWNER_ID },
    title: "Aoede workspace assistant",
    lifecycle: "active",
    attention: "none",
    revision: 1,
    messageCount: 0,
    currentSelection: { ...FIXTURE_SELECTION },
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

export type FixtureRunStatus = CanonicalChatRun["status"];

export interface FixtureRunOptions {
  id?: string;
  turnId?: string;
  status?: FixtureRunStatus;
  /** Cancellation capability exposed to the panel cancel affordance. */
  cancellation?: CanonicalChatRun["capabilitySnapshot"]["cancellation"];
}

export function fixtureRun(options: FixtureRunOptions = {}): CanonicalChatRun {
  const status = options.status ?? "running";
  const terminal = status === "completed" || status === "failed" || status === "aborted";
  return {
    id: options.id ?? "run_aoede_1",
    chatId: FIXTURE_CHAT_ID,
    turnId: options.turnId ?? "cturn_aoede_1",
    attempt: 1,
    driverKind: "codex",
    instanceId: FIXTURE_INSTANCE_ID,
    selection: { ...FIXTURE_SELECTION },
    interactionMode: "default",
    permissionMode: "supervised",
    executionRoot: { kind: "project", projectId: "matrix-os" },
    executionRootFingerprint: EXECUTION_ROOT_FINGERPRINT,
    status,
    ...(terminal ? { outcome: status, completedAt: T3 } : {}),
    ...(status === "accepted" ? {} : { startedAt: T1 }),
    historyBoundarySeq: 0,
    runPolicy: {
      memoryMode: "ordinary",
      source: "voice",
      voiceSessionId: FIXTURE_SESSION_ID,
      nativeCheckpointPolicy: "reusable",
    },
    capabilitySnapshot: {
      revision: "catalog_fixture_1",
      rootChat: true,
      attachments: ["file"],
      resources: ["file", "app"],
      tools: ["matrix_list_apps", "matrix_inspect_app", "matrix_search_workspace", "matrix_open_app", "matrix_apply_app_files"],
      approvals: true,
      userInput: true,
      resume: true,
      cancellation: options.cancellation ?? "run",
      approvalBinding: "argument_digest",
      steering: "none",
      worktrees: "optional",
      interactionModes: ["default"],
      permissionModes: ["supervised"],
    },
    createdAt: T0,
    updatedAt: T3,
  };
}

export function fixtureTurn(options: { id?: string; inputMessageId?: string; status?: CanonicalChatTurn["status"] } = {}): CanonicalChatTurn {
  return {
    id: options.id ?? "cturn_aoede_1",
    chatId: FIXTURE_CHAT_ID,
    clientRequestId: "req_aoede_turn_1",
    baseMessageSeq: 0,
    inputMessageId: options.inputMessageId ?? "msg_aoede_u1",
    status: options.status ?? "running",
    createdAt: T0,
    updatedAt: T1,
  };
}

export function fixtureUserMessage(text: string, options: { id?: string; seq?: number; turnId?: string } = {}): CanonicalChatMessage {
  return {
    id: options.id ?? "msg_aoede_u1",
    chatId: FIXTURE_CHAT_ID,
    seq: options.seq ?? 1,
    role: "user",
    state: "committed",
    ...(options.turnId ? { turnId: options.turnId } : { turnId: "cturn_aoede_1" }),
    parts: [{ type: "text", text }],
    createdAt: T0,
  };
}

export function fixtureAssistantMessage(
  text: string,
  options: { id?: string; seq?: number; turnId?: string; runId?: string; extraParts?: CanonicalChatMessagePart[] } = {},
): CanonicalChatMessage {
  return {
    id: options.id ?? "msg_aoede_a1",
    chatId: FIXTURE_CHAT_ID,
    seq: options.seq ?? 2,
    role: "assistant",
    state: "committed",
    turnId: options.turnId ?? "cturn_aoede_1",
    runId: options.runId ?? "run_aoede_1",
    parts: [{ type: "text", text }, ...(options.extraParts ?? [])],
    createdAt: T2,
  };
}

export function fileReference(path: string, label: string, id: string): CanonicalChatMessagePart {
  return { type: "resource_reference", resource: { kind: "file", id, label, path } };
}

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type ActivityInput = DistributiveOmit<CanonicalChatRunActivity, "id" | "chatId" | "runId" | "occurredAt" | "sequence">;

export function fixtureActivity(activity: ActivityInput, options: { id: string; runId?: string; occurredAt?: string; sequence?: number }): CanonicalChatRunActivity {
  return {
    id: options.id,
    chatId: FIXTURE_CHAT_ID,
    runId: options.runId ?? "run_aoede_1",
    ...(options.sequence === undefined ? {} : { sequence: options.sequence }),
    occurredAt: options.occurredAt ?? T2,
    ...activity,
  } as CanonicalChatRunActivity;
}

export interface FixtureOperationOptions {
  id: string;
  runId?: string;
  toolId: string;
  state: CanonicalOperationView["state"];
  argumentDigest?: string;
  cancellationRequested?: boolean;
  result?: CanonicalOperationView["result"];
  updatedAt?: string;
}

export function fixtureOperation(options: FixtureOperationOptions): CanonicalOperationView {
  return {
    id: options.id,
    chatId: FIXTURE_CHAT_ID,
    runId: options.runId ?? "run_aoede_1",
    toolId: options.toolId,
    schemaRevision: "canonical_apps_v1",
    policyRevision: "codex_canonical_v1",
    state: options.state,
    argumentDigest: options.argumentDigest ?? DIGEST_APPLY,
    cancellationRequested: options.cancellationRequested ?? false,
    ...(options.result ? { result: options.result } : {}),
    createdAt: T2,
    updatedAt: options.updatedAt ?? T3,
  };
}

export interface FixtureDetailOptions {
  revision?: number;
  attention?: CanonicalChat["attention"];
  runStatus?: FixtureRunStatus;
  activeRun?: boolean;
  messages?: CanonicalChatMessage[];
  activities?: CanonicalChatRunActivity[];
  operations?: CanonicalOperationView[];
  turnStatus?: CanonicalChatTurn["status"];
}

/**
 * A detail payload consistent across chat/turn/run/message/activity identity —
 * the same shape canonical Chat serves on `GET /api/chats/:id`.
 */
export function fixtureDetail(options: FixtureDetailOptions = {}): CanonicalChatDetailResponse {
  const runStatus = options.runStatus;
  const run = runStatus ? fixtureRun({ status: runStatus }) : null;
  const terminal = runStatus === "completed" || runStatus === "failed" || runStatus === "aborted";
  const active = runStatus !== undefined && !terminal;
  const turnStatus = options.turnStatus
    ?? (terminal ? runStatus : runStatus === "accepted" ? "accepted" : "running");
  const messages = options.messages ?? (runStatus ? [fixtureUserMessage("Open the timer app on my desktop.")] : []);
  return {
    record: {
      chat: fixtureChat({
        revision: options.revision ?? 1,
        attention: options.attention ?? "none",
        messageCount: messages.length,
        ...(messages.length ? { lastMessagePreview: messages.at(-1)?.parts.flatMap(p => p.type === "text" ? [p.text] : []).join(" ").slice(0, 200) ?? "" } : {}),
      }),
      ...(runStatus ? { providerBinding: { driverKind: "codex", instanceId: FIXTURE_INSTANCE_ID, lockedAtTurnId: "cturn_aoede_1" } } : {}),
      ...(run && active ? { activeRun: { runId: run.id, turnId: run.turnId, status: runStatus as "accepted" | "running" | "waiting_for_approval" | "waiting_for_input" } } : {}),
    },
    messages,
    turns: runStatus ? [fixtureTurn({ status: turnStatus as CanonicalChatTurn["status"] })] : [],
    runs: run ? [run] : [],
    activities: options.activities ?? [],
    ...(options.operations ? { operations: options.operations } : {}),
  };
}

/**
 * Provider catalog served by `GET /api/chat-providers` — the Codex instance is
 * the qualified action provider the spec requires on the standalone chooser.
 */
export function fixtureProviderCatalog(): CanonicalProviderCatalog {
  return {
    revision: "catalog_fixture_1",
    drivers: [{
      kind: "codex",
      displayName: "Codex",
      adapterVersion: "1.0.0",
      capabilityClass: "coding_agent",
    }],
    instances: [{
      id: FIXTURE_INSTANCE_ID,
      driverKind: "codex",
      displayName: "Codex fixture",
      availability: "available",
      workspaceRequirement: "project_optional",
      catalogRevision: "catalog_fixture_1",
      models: [{
        id: FIXTURE_MODEL,
        displayName: "GPT-5.6-Sol",
        availability: "available",
        capabilities: ["reasoning", "tools"],
        supportsVision: false,
        supportsToolUse: true,
      }],
      options: [],
      skills: [],
      commands: [],
      setupActions: [],
      supports: {
        rootChat: true,
        resume: true,
        cancellation: "run",
        approvalBinding: "argument_digest",
        attachments: ["file"],
        tools: ["matrix_list_apps", "matrix_inspect_app", "matrix_search_workspace", "matrix_open_app", "matrix_apply_app_files"],
        approvals: true,
        userInput: true,
        worktrees: "optional",
        resources: ["file", "app"],
        interactionModes: ["default"],
        permissionModes: ["supervised"],
      },
      defaultSelection: { ...FIXTURE_SELECTION },
    }],
  };
}

/** Shared result payload for the navigation/artifact/reconciliation scenario. */
export function navigationArtifactOperations(): CanonicalOperationView[] {
  return [
    fixtureOperation({
      id: "action_cancelled_search",
      toolId: "matrix_search_workspace",
      state: "cancelled",
      argumentDigest: DIGEST_SEARCH,
      cancellationRequested: true,
      updatedAt: T2,
      result: { matches: [{ path: "apps/timer/App.tsx", line: 12, text: "export function Timer()" }] },
    }),
    fixtureOperation({
      id: "action_unknown_apply",
      toolId: "matrix_apply_app_files",
      state: "outcome_unknown",
      argumentDigest: DIGEST_UNKNOWN,
      updatedAt: T3,
      result: { files: [{ path: "apps/timer/manifest.json", truncated: false }] },
    }),
    fixtureOperation({
      id: "action_running_inspect",
      toolId: "matrix_inspect_app",
      state: "running",
      argumentDigest: DIGEST_RUNNING,
      cancellationRequested: true,
      updatedAt: T3,
    }),
    fixtureOperation({
      id: "action_apply_timer",
      toolId: "matrix_apply_app_files",
      state: "succeeded",
      argumentDigest: DIGEST_APPLY,
      updatedAt: T3,
      result: {
        artifact: { kind: "file_batch", path: "apps/timer" },
        files: [
          { path: "apps/timer/App.tsx", sha256: FILE_SHA },
          { path: "apps/timer/manifest.json", sha256: "9a".repeat(32) },
        ],
      },
    }),
    fixtureOperation({
      id: "action_open_timer",
      toolId: "matrix_open_app",
      state: "succeeded",
      argumentDigest: DIGEST_OPEN,
      updatedAt: T4,
      result: { navigation: { kind: "open_app", app: "timer", path: "apps/timer" } },
    }),
  ];
}
