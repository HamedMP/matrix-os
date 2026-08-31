import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, isAbsolute, relative } from "node:path";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod/v4";
import { assertCodexProviderVersion } from "./codex-provider-version-check.mjs";
import { createCodexSessionApprovalGrants } from "./codex-session-approvals.mjs";

process.on("uncaughtException", () => {
  process.stderr.write("Codex app-server runner stopped unexpectedly.\n");
  process.exit(1);
});
process.on("unhandledRejection", () => {
  process.stderr.write("Codex app-server runner stopped unexpectedly.\n");
  process.exit(1);
});

const MAX_LINE_BYTES = 64 * 1024;
const MAX_PROVIDER_LINE_BYTES = 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_REQUESTS = 20;
const MAX_COMPLETED_REQUESTS = 100;
const MAX_CONTROL_SOCKETS = 20;
const MAX_TRACKED_ITEMS = 500;
const MAX_PENDING_TURNS = 20;
const MAX_TURN_FRAME_BYTES = 128 * 1024;
const ASSISTANT_DELTA_FLUSH_CHARS = 16;
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const RPC_TIMEOUT_MS = 30 * 1000;
const CONTROL_SOCKET_TIMEOUT_MS = 10_000;
const PROVIDER_STOP_TIMEOUT_MS = 5_000;
const SHUTDOWN_REPLAY_GRACE_MS = 250;
const TURN_FRAME_V1_PREFIX = "matrix-turn-v1:";
const TURN_FRAME_V2_PREFIX = "matrix-turn-v2:";
const UNSAFE_DISPLAY_TEXT = /(stack trace|\/home\/|\/tmp\/|\/var\/|\.ssh\/|id_rsa|bearer\s+[A-Za-z0-9._-]+|sk-[A-Za-z0-9_-]+)/i;
const CREDENTIAL_DISPLAY_TEXT = /(?:api[_-]?key|authorization|cookie|credential|password|secret|token)\s*(?:=|:|\s)/i;
const NativeRequestIdSchema = z.union([z.string().min(1).max(128), z.number().int().safe()]);
const NativeReferenceSchema = z.string().min(1).max(512);
const ApprovalMethodSchema = z.enum([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
]);
const ApprovalDecisionSchema = z.enum(["approve", "approve_for_session", "decline", "cancel"]);
const NativeApprovalDecisionSchema = z.union([
  z.enum(["accept", "acceptForSession", "decline", "cancel"]),
  z.object({
    acceptWithExecpolicyAmendment: z.object({
      execpolicy_amendment: z.array(z.string().max(4000)).max(128),
    }).strict(),
  }).strict(),
  z.object({
    applyNetworkPolicyAmendment: z.object({
      network_policy_amendment: z.object({
        action: z.enum(["allow", "deny"]),
        host: z.string().min(1).max(255),
      }).strict(),
    }).strict(),
  }).strict(),
]);
const NativeApprovalDecisionListSchema = z.array(z.unknown()).max(16).transform((decisions) =>
  decisions.flatMap((decision) => {
    const parsed = NativeApprovalDecisionSchema.safeParse(decision);
    return parsed.success ? [parsed.data] : [];
  }));
// This runner is executed directly by plain Node, so keep this boundary schema
// aligned with ProviderModelReferenceSchema from @matrix-os/contracts.
const ProviderModelReferenceSchema = z.string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.:-]*)*$/)
  .refine((value) => !value.includes(".."));
const RunnerConfigSchema = z.object({
  prompt: z.string().trim().min(1).max(64 * 1024),
  providerThreadId: NativeReferenceSchema.optional(),
  approvalPolicy: z.enum(["untrusted", "on-request", "never"]),
  sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]),
  writableRoots: z.array(z.string().min(1).max(4096).refine(isAbsolute)).max(20),
  model: ProviderModelReferenceSchema.optional(),
  effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]).optional(),
  serviceTier: z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/).optional(),
}).strict();
const ModelOptionSchema = z.object({
  id: z.string().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/),
  value: z.union([
    z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/),
    z.boolean(),
  ]),
}).strict();
const PendingTurnSchema = z.object({
  prompt: z.string().trim().min(1).max(64 * 1024),
  model: RunnerConfigSchema.shape.model,
  modelOptions: z.array(ModelOptionSchema).max(32).default([]),
}).strict();
const EffortSchema = RunnerConfigSchema.shape.effort;
const ServiceTierSchema = RunnerConfigSchema.shape.serviceTier;
const ApprovalRequestSchema = z.object({
  id: NativeRequestIdSchema,
  method: ApprovalMethodSchema,
  params: z.object({
    threadId: NativeReferenceSchema,
    turnId: NativeReferenceSchema,
    itemId: NativeReferenceSchema,
    availableDecisions: NativeApprovalDecisionListSchema.nullable().optional(),
  }).passthrough(),
}).passthrough();
const DisplayTextSchema = z.string()
  .refine((value) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value));
const NativeQuestionSchema = z.object({
  id: z.string().min(1).max(128),
  header: DisplayTextSchema.min(1).max(160),
  question: DisplayTextSchema.min(1).max(2400),
  options: z.array(z.object({
    label: DisplayTextSchema.min(1).max(160),
    description: DisplayTextSchema.min(1).max(1200),
  }).passthrough()).min(1).max(10).nullable().optional(),
  isOther: z.boolean().default(false),
  isSecret: z.boolean().default(false),
}).passthrough();
const InputRequestSchema = z.object({
  id: NativeRequestIdSchema,
  method: z.literal("item/tool/requestUserInput"),
  params: z.object({
    threadId: NativeReferenceSchema,
    turnId: NativeReferenceSchema,
    itemId: NativeReferenceSchema,
    autoResolutionMs: z.number().int().min(0).max(240_000).nullable().optional(),
    questions: z.array(NativeQuestionSchema).min(1).max(8),
  }).passthrough(),
}).passthrough();
const AgentDeltaSchema = z.object({
  method: z.literal("item/agentMessage/delta"),
  params: z.object({
    turnId: NativeReferenceSchema,
    itemId: NativeReferenceSchema,
    delta: z.string().max(MAX_LINE_BYTES),
  }).passthrough(),
}).passthrough();
const ToolOutputDeltaSchema = z.object({
  method: z.enum([
    "item/commandExecution/outputDelta",
    "item/fileChange/outputDelta",
    "item/mcpToolCall/progress",
    "item/dynamicToolCall/outputDelta",
  ]),
  params: z.object({
    turnId: NativeReferenceSchema,
    itemId: NativeReferenceSchema,
  }).passthrough(),
}).passthrough();
const MessagePhaseSchema = z.enum(["commentary", "final_answer"]);
const ToolLifecycleTypeSchema = z.enum([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "webSearch",
  "plan",
  "reasoning",
]);
const AgentMessageLifecycleItemSchema = z.object({
  id: NativeReferenceSchema,
  type: z.literal("agentMessage"),
  text: z.string().max(MAX_PROVIDER_LINE_BYTES),
  phase: MessagePhaseSchema.nullable().optional(),
}).passthrough();
const ToolLifecycleItemSchema = z.object({
  id: NativeReferenceSchema,
  type: ToolLifecycleTypeSchema,
  server: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/).optional(),
  tool: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/).optional(),
  status: z.string().max(80).optional(),
  command: z.string().max(MAX_PROVIDER_LINE_BYTES).optional(),
  cwd: z.string().max(4_096).optional(),
  changes: z.array(z.object({
    path: z.string().min(1).max(4_096),
  }).passthrough()).max(200).optional(),
  aggregatedOutput: z.string().max(MAX_PROVIDER_LINE_BYTES).nullable().optional(),
  result: z.unknown().nullable().optional(),
  error: z.unknown().nullable().optional(),
}).passthrough();
const IgnoredLifecycleItemSchema = z.object({
  id: NativeReferenceSchema,
  type: z.string().min(1).max(80).refine((type) => (
    type !== "agentMessage" && !ToolLifecycleTypeSchema.options.includes(type)
  )),
}).passthrough();
const LifecycleItemSchema = z.union([
  AgentMessageLifecycleItemSchema,
  ToolLifecycleItemSchema,
  IgnoredLifecycleItemSchema,
]);
const ItemLifecycleSchema = z.object({
  method: z.enum(["item/started", "item/completed"]),
  params: z.object({
    turnId: NativeReferenceSchema,
    item: LifecycleItemSchema,
  }).passthrough(),
}).passthrough();
const TurnCompletedSchema = z.object({
  method: z.literal("turn/completed"),
  params: z.object({
    turn: z.object({
      status: z.enum(["completed", "interrupted", "failed", "inProgress"]),
    }).passthrough(),
  }).passthrough(),
}).passthrough();
const RpcResponseSchema = z.object({
  id: NativeRequestIdSchema,
  result: z.unknown().optional(),
  error: z.unknown().optional(),
}).passthrough();
const ApprovalControlSchema = z.object({
  type: z.literal("approval"),
  approvalId: z.string().regex(/^appr_codex_[a-f0-9]{32}$/),
  decision: ApprovalDecisionSchema,
  clientRequestId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/),
}).strict();
const MatrixQuestionIdSchema = z.string().regex(/^question_codex_[a-f0-9]{24}$/);
const InputControlSchema = z.object({
  type: z.literal("input"),
  requestId: z.string().regex(/^req_codex_[a-f0-9]{32}$/),
  structuredAnswers: z.record(
    MatrixQuestionIdSchema,
    z.array(z.string().min(1).max(400).refine((value) => Buffer.byteLength(value, "utf8") <= 700))
      .min(1).max(4),
  ).superRefine((answers, context) => {
    const count = Object.keys(answers).length;
    if (count < 1 || count > 8) context.addIssue({ code: "custom", message: "Invalid answer count" });
  }),
  clientRequestId: ApprovalControlSchema.shape.clientRequestId,
}).strict();
const TurnControlSchema = PendingTurnSchema.extend({
  type: z.literal("turn"),
  clientRequestId: ApprovalControlSchema.shape.clientRequestId,
}).strict();
const InterruptControlSchema = z.object({
  type: z.literal("interrupt"),
  clientRequestId: ApprovalControlSchema.shape.clientRequestId,
}).strict();
const SteerControlSchema = z.object({
  type: z.literal("steer"),
  prompt: PendingTurnSchema.shape.prompt,
  clientRequestId: ApprovalControlSchema.shape.clientRequestId,
}).strict();
const ControlSchema = z.discriminatedUnion("type", [
  TurnControlSchema,
  SteerControlSchema,
  InterruptControlSchema,
  ApprovalControlSchema,
  InputControlSchema,
]);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const eventPath = process.argv[2];
const expectedVersion = process.argv[3];
const command = process.argv[4];
const encodedConfig = process.argv.at(-1);
const commandArgs = process.argv.slice(5, -1);
if (
  !eventPath ||
  !isAbsolute(eventPath) ||
  !/^[^\u0000\r\n]+\.jsonl$/.test(eventPath) ||
  !/^\d+\.\d+\.\d+$/.test(expectedVersion ?? "") ||
  !command
) {
  fail("Codex app-server runner configuration is invalid.");
}
let config;
try {
  const bytes = Buffer.from(encodedConfig ?? "", "base64");
  if (bytes.toString("base64") !== encodedConfig) throw new Error("invalid_base64");
  config = RunnerConfigSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
} catch (_error) {
  fail("Codex app-server runner configuration is invalid.");
}

try {
  await assertCodexProviderVersion({ command, expectedVersion, cwd: process.cwd() });
} catch (_error) {
  fail("Codex provider version is not verified.");
}

const controlPath = eventPath.replace(/\.jsonl$/, ".sock");
await mkdir(dirname(eventPath), { recursive: true });
for (const path of [eventPath, controlPath]) {
  try {
    const existing = await lstat(path);
    if (path === controlPath && existing.isSocket()) {
      await rm(path, { force: true });
      continue;
    }
    if (existing.isSymbolicLink() || (path === eventPath && !existing.isFile())) {
      throw new Error("unsafe_provider_path");
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

const eventFile = await open(
  eventPath,
  constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
  0o600,
);
let transcriptBytes = (await eventFile.stat()).size;
let stopping = false;
let activeTurn = false;
let activeTurnOutcome;
let nativeThreadId;
let activeNativeTurnId;
let terminalEventCount = 0;
let stdinClosed = false;
let wakeTurn;
const pendingTurns = [];
let stopTimer;
let nextRpcId = 1;
const pendingRpc = new Map();
const pendingApprovals = new Map();
const sessionApprovalGrants = createCodexSessionApprovalGrants();
const pendingInputs = new Map();
const completedControls = new Map();
const assistantItemsWithDelta = new Set();
const assistantDeltaBuffers = new Map();
const startedToolItems = new Set();
const toolItemsWithOutput = new Set();

function digest(parts) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
}

function itemIdentity(nativeTurnId, nativeItemId) {
  return `codex_item_${digest([nativeTurnId, nativeItemId])}`;
}

function assertTrackedItemCapacity(collection, value) {
  if (!collection.has(value) && collection.size >= MAX_TRACKED_ITEMS) {
    throw new Error("provider_item_limit");
  }
}

function toolPresentation(item) {
  if (item.type === "commandExecution") return { displayName: "Run command", kind: "command" };
  if (item.type === "fileChange") return { displayName: "Update files", kind: "file_change" };
  if (item.type === "webSearch") return { displayName: "Search web", kind: "search" };
  if (item.type === "plan") return { displayName: "Update plan", kind: "plan" };
  if (item.type === "reasoning") return { displayName: "Thinking", kind: "reasoning" };
  if (item.type === "collabAgentToolCall") return { displayName: "Coordinate agents", kind: "agent" };
  if (item.type === "mcpToolCall" && item.server && item.tool) {
    return { displayName: `Use ${item.server}.${item.tool}`, kind: "tool" };
  }
  return { displayName: "Use tool", kind: "tool" };
}

function safeDisplayPath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096 || value.includes("\0")) {
    return undefined;
  }
  const normalized = value.replaceAll("\\", "/");
  if (!isAbsolute(normalized)) {
    if (normalized.split("/").includes("..")) return undefined;
    return normalized;
  }
  const ownerHome = "/home/matrix/home";
  if (normalized === ownerHome) return "~/";
  if (normalized.startsWith(`${ownerHome}/`)) return `~/${normalized.slice(ownerHome.length + 1)}`;
  for (const writableRoot of config.writableRoots) {
    const root = writableRoot.replaceAll("\\", "/").replace(/\/$/, "");
    if (normalized !== root && !normalized.startsWith(`${root}/`)) continue;
    const ownerRelative = relative(root, normalized).replaceAll("\\", "/");
    return ownerRelative || ".";
  }
  return undefined;
}

function safeToolDetails(item) {
  if (item.type === "commandExecution") {
    const command = typeof item.command === "string" ? item.command.trim() : "";
    const safeCommand = command.length > 0
      && command.length <= 1_000
      && !UNSAFE_DISPLAY_TEXT.test(command)
      && !CREDENTIAL_DISPLAY_TEXT.test(command)
      && !/[\r\n\u0000]/.test(command)
      ? command
      : undefined;
    const cwd = safeDisplayPath(item.cwd);
    return {
      ...(safeCommand ? { preview: safeCommand, previewKind: "command" } : {}),
      ...(cwd ? { detail: `Working directory: ${cwd}` } : {}),
    };
  }
  if (item.type === "fileChange") {
    const path = safeDisplayPath(item.changes?.[0]?.path);
    return path ? { preview: path, previewKind: "path" } : {};
  }
  return {};
}

function toolOutcome(status) {
  if (status === undefined || status === "completed") return "success";
  if (status === "declined" || status === "cancelled") return "cancelled";
  return "failed";
}

function itemHasOutput(item) {
  return (
    (typeof item.aggregatedOutput === "string" && item.aggregatedOutput.length > 0) ||
    (item.result !== null && item.result !== undefined) ||
    (item.error !== null && item.error !== undefined)
  );
}

function approvalIdentity(request) {
  const parts = [
    request.method,
    request.id,
    request.params.threadId,
    request.params.turnId,
    request.params.itemId,
  ];
  return {
    approvalId: `appr_codex_${digest([...parts, "approval"])}`,
    correlationId: `corr_codex_${digest(parts)}`,
  };
}

function inputIdentity(request) {
  const parts = [
    request.method,
    request.id,
    request.params.threadId,
    request.params.turnId,
    request.params.itemId,
  ];
  return {
    requestId: `req_codex_${digest([...parts, "input"])}`,
    correlationId: `corr_codex_${digest(parts)}`,
  };
}

function boundedExternalText(value, maxChars, maxBytes) {
  let result = "";
  for (const character of value) {
    const candidate = `${result}${character}`;
    if (candidate.length > maxChars || Buffer.byteLength(candidate, "utf8") > maxBytes) break;
    result = candidate;
  }
  return result;
}

function safeExternalText(value, fallback, maxChars, maxBytes) {
  const bounded = boundedExternalText(value, maxChars, maxBytes);
  return bounded.trim() && !UNSAFE_DISPLAY_TEXT.test(bounded) ? bounded : fallback;
}

async function persist(value) {
  const line = JSON.stringify(value);
  const bytes = Buffer.byteLength(`${line}\n`, "utf8");
  if (bytes > MAX_LINE_BYTES || transcriptBytes + bytes > MAX_TRANSCRIPT_BYTES) {
    throw new Error("provider_transcript_limit");
  }
  await eventFile.write(`${line}\n`);
  transcriptBytes += bytes;
}

async function flushAssistantDelta(messageId) {
  const delta = assistantDeltaBuffers.get(messageId);
  if (!delta) return;
  await persist({ type: "matrix.codex.assistant.delta", messageId, delta });
  assistantDeltaBuffers.delete(messageId);
}

async function bufferAssistantDelta(messageId, delta) {
  if (!assistantDeltaBuffers.has(messageId) && assistantDeltaBuffers.size >= MAX_TRACKED_ITEMS) {
    const oldest = assistantDeltaBuffers.keys().next().value;
    if (oldest) await flushAssistantDelta(oldest);
  }
  const buffered = `${assistantDeltaBuffers.get(messageId) ?? ""}${delta}`;
  assistantDeltaBuffers.set(messageId, buffered);
  if (buffered.length >= ASSISTANT_DELTA_FLUSH_CHARS || buffered.includes("\n")) {
    await flushAssistantDelta(messageId);
  }
}

function sendProvider(value) {
  if (!child.stdin.writable) throw new Error("provider_transport_closed");
  child.stdin.write(`${JSON.stringify(value)}\n`);
}

function request(method, params) {
  if (pendingRpc.size >= MAX_PENDING_REQUESTS) {
    return Promise.reject(new Error("provider_request_limit"));
  }
  const id = nextRpcId++;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRpc.delete(id);
      reject(new Error("provider_request_timeout"));
    }, RPC_TIMEOUT_MS);
    timeout.unref();
    pendingRpc.set(id, { resolve, reject, timeout });
    sendProvider({ id, method, params });
  });
}

function approvalCopy(method) {
  if (method === "item/commandExecution/requestApproval") {
    return { title: "Run command", safeDescription: "The coding agent wants to run a command.", actionKind: "command", risk: "medium" };
  }
  if (method === "item/fileChange/requestApproval") {
    return { title: "Change files", safeDescription: "The coding agent wants to change project files.", actionKind: "file_change", risk: "medium" };
  }
  return { title: "Change permissions", safeDescription: "The coding agent wants additional permissions.", actionKind: "provider", risk: "high" };
}

function decisionMapping(request) {
  const source = request.params.availableDecisions ?? ["accept", "acceptForSession", "decline", "cancel"];
  const nativeDecisionByMatrixDecision = {};
  const choicesByMatrixDecision = new Map();
  for (const decision of source) {
    const matrixDecision = decision === "accept"
      ? "approve"
      : decision === "acceptForSession" || typeof decision === "object"
        ? "approve_for_session"
        : decision;
    const choices = choicesByMatrixDecision.get(matrixDecision) ?? [];
    if (!choices.some((choice) => digest([choice]) === digest([decision]))) choices.push(decision);
    choicesByMatrixDecision.set(matrixDecision, choices);
  }
  const allowedDecisions = [];
  for (const [matrixDecision, choices] of choicesByMatrixDecision) {
    if (matrixDecision === "approve_for_session" && choices.length !== 1) continue;
    allowedDecisions.push(matrixDecision);
    nativeDecisionByMatrixDecision[matrixDecision] = choices[0];
  }
  return {
    allowedDecisions,
    nativeDecisionByMatrixDecision,
  };
}

async function handleApproval(raw) {
  const parsed = ApprovalRequestSchema.safeParse(raw);
  if (!parsed.success) return false;
  if (parsed.data.method === "item/permissions/requestApproval") {
    sendProvider({
      id: parsed.data.id,
      error: { code: -32601, message: "Permission request is unavailable." },
    });
    return true;
  }
  const identity = approvalIdentity(parsed.data);
  const decisions = decisionMapping(parsed.data);
  const sessionDecision = sessionApprovalGrants.decisionFor(
    parsed.data.method,
    decisions.nativeDecisionByMatrixDecision,
  );
  if (sessionDecision !== undefined) {
    sendProvider({ id: parsed.data.id, result: { decision: sessionDecision } });
    return true;
  }
  if (decisions.allowedDecisions.length === 0) {
    sendProvider({ id: parsed.data.id, result: { decision: "cancel" } });
    return true;
  }
  if (pendingApprovals.size >= MAX_PENDING_REQUESTS || pendingApprovals.has(identity.approvalId)) {
    sendProvider({ id: parsed.data.id, result: { decision: "cancel" } });
    return true;
  }
  await persist({
    type: "matrix.codex.approval.requested",
    approvalId: identity.approvalId,
    correlationId: identity.correlationId,
    ...approvalCopy(parsed.data.method),
    allowedDecisions: decisions.allowedDecisions,
  });
  pendingApprovals.set(identity.approvalId, {
    nativeRequestId: parsed.data.id,
    method: parsed.data.method,
    allowedDecisions: decisions.allowedDecisions,
    nativeDecisionByMatrixDecision: decisions.nativeDecisionByMatrixDecision,
    expiresAt: Date.now() + REQUEST_TIMEOUT_MS,
  });
  return true;
}

async function handleInput(raw) {
  const parsed = InputRequestSchema.safeParse(raw);
  if (!parsed.success) return false;
  const nativeQuestionIds = parsed.data.params.questions.map((question) => question.id);
  if (new Set(nativeQuestionIds).size !== nativeQuestionIds.length) {
    sendProvider({ id: parsed.data.id, result: { answers: {} } });
    return true;
  }
  if (pendingInputs.size >= MAX_PENDING_REQUESTS) {
    sendProvider({ id: parsed.data.id, result: { answers: {} } });
    return true;
  }
  const identity = inputIdentity(parsed.data);
  if (pendingInputs.has(identity.requestId)) {
    sendProvider({ id: parsed.data.id, result: { answers: {} } });
    return true;
  }
  const questions = parsed.data.params.questions.map((question, index) => ({
    questionId: `question_codex_${digest([identity.requestId, question.id, index]).slice(0, 24)}`,
    header: safeExternalText(question.header, "Question", 120, 512),
    question: safeExternalText(
      question.question,
      "The coding agent needs an answer.",
      600,
      2400,
    ),
    ...(question.options ? { options: question.options.map((option, optionIndex) => ({
      label: safeExternalText(option.label, `Option ${optionIndex + 1}`, 120, 512),
      description: safeExternalText(option.description, "Choose this option.", 300, 1200),
    })) } : {}),
    allowOther: question.isOther,
    secret: question.isSecret,
  }));
  await persist({
    type: "matrix.codex.user_input.requested",
    requestId: identity.requestId,
    correlationId: identity.correlationId,
    title: questions[0]?.header ?? "Question",
    safeDescription: "The coding agent needs more information.",
    questions,
    ...(typeof parsed.data.params.autoResolutionMs === "number" && parsed.data.params.autoResolutionMs >= 60_000
      ? { autoResolutionMs: parsed.data.params.autoResolutionMs }
      : {}),
  });
  pendingInputs.set(identity.requestId, {
    nativeRequestId: parsed.data.id,
    questions: questions.map((question, index) => ({
      questionId: question.questionId,
      nativeQuestionId: parsed.data.params.questions[index].id,
    })),
    expiresAt: Date.now() + REQUEST_TIMEOUT_MS,
  });
  return true;
}

async function handleItemLifecycle(raw) {
  const parsed = ItemLifecycleSchema.safeParse(raw);
  if (!parsed.success) return false;
  const { item } = parsed.data.params;
  const matrixItemId = itemIdentity(parsed.data.params.turnId, item.id);

  if (item.type === "agentMessage") {
    if (parsed.data.method === "item/completed") {
      await flushAssistantDelta(matrixItemId);
      if (!assistantItemsWithDelta.has(matrixItemId) && item.text.length > 0) {
        await persist({
          type: "matrix.codex.assistant.delta",
          messageId: matrixItemId,
          delta: item.text,
        });
      }
      await persist({ type: "matrix.codex.assistant.completed", messageId: matrixItemId });
      assistantItemsWithDelta.delete(matrixItemId);
    }
    return true;
  }
  if (!ToolLifecycleTypeSchema.options.includes(item.type)) {
    return true;
  }

  const presentation = toolPresentation(item);
  const details = safeToolDetails(item);
  if (parsed.data.method === "item/started") {
    assertTrackedItemCapacity(startedToolItems, matrixItemId);
    await persist({
      type: "matrix.codex.tool.started",
      toolCallId: matrixItemId,
      ...presentation,
      ...details,
    });
    startedToolItems.add(matrixItemId);
    return true;
  }

  if (!startedToolItems.has(matrixItemId)) {
    assertTrackedItemCapacity(startedToolItems, matrixItemId);
    await persist({
      type: "matrix.codex.tool.started",
      toolCallId: matrixItemId,
      ...presentation,
      ...details,
    });
    startedToolItems.add(matrixItemId);
  }
  if (toolItemsWithOutput.has(matrixItemId) || itemHasOutput(item)) {
    await persist({
      type: "matrix.codex.tool.output",
      toolCallId: matrixItemId,
      text: item.type === "commandExecution" ? "Command produced output." : "Tool returned a result.",
      truncated: true,
    });
  }
  await persist({
    type: "matrix.codex.tool.completed",
    toolCallId: matrixItemId,
    outcome: toolOutcome(item.status),
  });
  startedToolItems.delete(matrixItemId);
  toolItemsWithOutput.delete(matrixItemId);
  return true;
}

async function handleProviderMessage(raw) {
  const response = RpcResponseSchema.safeParse(raw);
  if (response.success && pendingRpc.has(response.data.id)) {
    const pending = pendingRpc.get(response.data.id);
    pendingRpc.delete(response.data.id);
    clearTimeout(pending.timeout);
    if (response.data.error !== undefined) pending.reject(new Error("provider_request_failed"));
    else pending.resolve(response.data.result);
    return;
  }
  if (await handleApproval(raw)) return;
  if (await handleInput(raw)) return;
  if (await handleItemLifecycle(raw)) return;
  const outputDelta = ToolOutputDeltaSchema.safeParse(raw);
  if (outputDelta.success) {
    const toolCallId = itemIdentity(
      outputDelta.data.params.turnId,
      outputDelta.data.params.itemId,
    );
    assertTrackedItemCapacity(toolItemsWithOutput, toolCallId);
    toolItemsWithOutput.add(toolCallId);
    return;
  }
  const delta = AgentDeltaSchema.safeParse(raw);
  if (delta.success) {
    const messageId = itemIdentity(delta.data.params.turnId, delta.data.params.itemId);
    assertTrackedItemCapacity(assistantItemsWithDelta, messageId);
    await bufferAssistantDelta(messageId, delta.data.params.delta);
    assistantItemsWithDelta.add(messageId);
    return;
  }
  const completed = TurnCompletedSchema.safeParse(raw);
  if (completed.success) {
    const status = completed.data.params.turn.status;
    await finishTurn(status === "completed" ? "completed" : status === "interrupted" ? "aborted" : "failed");
  }
}

async function processProviderLine(line) {
  if (!line || Buffer.byteLength(line, "utf8") > MAX_PROVIDER_LINE_BYTES) return;
  try {
    await handleProviderMessage(JSON.parse(line));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
}

async function consumeProviderOutput(stream) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let discarding = false;
  for await (const chunk of stream) {
    let text = decoder.write(chunk);
    if (discarding) {
      const newline = text.indexOf("\n");
      if (newline < 0) continue;
      text = text.slice(newline + 1);
      discarding = false;
    }
    pending += text;
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      const line = pending.slice(0, newline).replace(/\r$/, "");
      pending = pending.slice(newline + 1);
      await processProviderLine(line);
      newline = pending.indexOf("\n");
    }
    if (Buffer.byteLength(pending, "utf8") > MAX_PROVIDER_LINE_BYTES) {
      pending = "";
      discarding = true;
    }
  }
  pending += decoder.end();
  if (!discarding) await processProviderLine(pending.replace(/\r$/, ""));
}

async function discardProviderErrors(stream) {
  for await (const _chunk of stream) {
    // Provider stderr can include credentials, paths, or raw failures.
  }
}

function controlResponse(socket, value) {
  socket.end(`${JSON.stringify(value)}\n`);
}

async function applyControl(control) {
  const replay = completedControls.get(control.clientRequestId);
  if (replay) {
    const same = replay.fingerprint === digest([control]);
    return same ? { ok: true, replayed: true } : { ok: false };
  }
  if (control.type === "turn") {
    if (!enqueuePendingTurn(control)) return { ok: false };
  } else if (control.type === "steer") {
    if (!nativeThreadId || !activeNativeTurnId) return { ok: false };
    await request("turn/steer", {
      threadId: nativeThreadId,
      expectedTurnId: activeNativeTurnId,
      input: [{ type: "text", text: control.prompt, text_elements: [] }],
    });
  } else if (control.type === "interrupt") {
    if (!nativeThreadId || !activeNativeTurnId) return { ok: false };
    await request("turn/interrupt", { threadId: nativeThreadId, turnId: activeNativeTurnId });
  } else if (control.type === "approval") {
    const pending = pendingApprovals.get(control.approvalId);
    if (!pending || !pending.allowedDecisions.includes(control.decision)) return { ok: false };
    const nativeDecision = pending.nativeDecisionByMatrixDecision[control.decision];
    sendProvider({
      id: pending.nativeRequestId,
      result: { decision: nativeDecision },
    });
    if (control.decision === "approve_for_session") {
      sessionApprovalGrants.grant(pending.method);
    }
    pendingApprovals.delete(control.approvalId);
  } else {
    const pending = pendingInputs.get(control.requestId);
    if (!pending) return { ok: false };
    const expected = new Set(pending.questions.map((question) => question.questionId));
    const provided = Object.keys(control.structuredAnswers);
    if (provided.length !== expected.size || provided.some((questionId) => !expected.has(questionId))) {
      return { ok: false };
    }
    const answers = Object.fromEntries(pending.questions.map((question) => [
      question.nativeQuestionId,
      { answers: control.structuredAnswers[question.questionId] },
    ]));
    sendProvider({ id: pending.nativeRequestId, result: { answers } });
    pendingInputs.delete(control.requestId);
  }
  if (completedControls.size >= MAX_COMPLETED_REQUESTS) {
    const oldest = completedControls.keys().next().value;
    if (oldest) completedControls.delete(oldest);
  }
  completedControls.set(control.clientRequestId, {
    fingerprint: digest([control]),
    expiresAt: Date.now() + REQUEST_TIMEOUT_MS,
  });
  return { ok: true };
}

const controlSockets = new Set();
const controlServer = createServer({ allowHalfOpen: true }, (socket) => {
  if (controlSockets.size >= MAX_CONTROL_SOCKETS) {
    socket.destroy();
    return;
  }
  controlSockets.add(socket);
  let input = "";
  socket.setEncoding("utf8");
  socket.setTimeout(CONTROL_SOCKET_TIMEOUT_MS, () => socket.destroy());
  socket.once("close", () => controlSockets.delete(socket));
  socket.on("error", () => socket.destroy());
  socket.on("data", (chunk) => {
    input += chunk;
    if (Buffer.byteLength(input, "utf8") > MAX_TURN_FRAME_BYTES) socket.destroy();
  });
  socket.on("end", async () => {
    const line = input.trim();
    const parsed = ControlSchema.safeParse((() => {
      try { return JSON.parse(line); } catch (_error) { return undefined; }
    })());
    if (!parsed.success) {
      controlResponse(socket, { ok: false });
      return;
    }
    try {
      controlResponse(socket, await applyControl(parsed.data));
    } catch (_error) {
      controlResponse(socket, { ok: false });
    }
  });
});
await new Promise((resolve, reject) => {
  controlServer.once("error", reject);
  controlServer.listen(controlPath, resolve);
});
await chmod(controlPath, 0o600);

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [approvalId, pending] of pendingApprovals) {
    if (pending.expiresAt > now) continue;
    pendingApprovals.delete(approvalId);
    try { sendProvider({ id: pending.nativeRequestId, result: { decision: "cancel" } }); } catch (_error) { stopping = true; }
  }
  for (const [requestId, pending] of pendingInputs) {
    if (pending.expiresAt > now) continue;
    pendingInputs.delete(requestId);
    try { sendProvider({ id: pending.nativeRequestId, result: { answers: {} } }); } catch (_error) { stopping = true; }
  }
  for (const [requestId, completed] of completedControls) {
    if (completed.expiresAt <= now) completedControls.delete(requestId);
  }
}, 30_000);
cleanupTimer.unref();

const child = spawn(command, [...commandArgs, "app-server"], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
});
const childExit = new Promise((resolve) => {
  child.once("error", (error) => resolve({ code: null, signal: null, error }));
  child.once("close", (code, signal) => {
    if (stopTimer) clearTimeout(stopTimer);
    for (const pending of pendingRpc.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("provider_stopped"));
    }
    pendingRpc.clear();
    resolve({ code, signal });
  });
});

function decodeTurnFrame(line) {
  if (Buffer.byteLength(line, "utf8") > MAX_TURN_FRAME_BYTES) return undefined;
  const prefix = line.startsWith(TURN_FRAME_V2_PREFIX)
    ? TURN_FRAME_V2_PREFIX
    : line.startsWith(TURN_FRAME_V1_PREFIX)
      ? TURN_FRAME_V1_PREFIX
      : undefined;
  if (!prefix) return undefined;
  const encoded = line.slice(prefix.length);
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return undefined;
  try {
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded) return undefined;
    const decoded = new TextDecoder("utf8", { fatal: true }).decode(bytes);
    return prefix === TURN_FRAME_V1_PREFIX
      ? PendingTurnSchema.safeParse({ prompt: decoded, modelOptions: [] }).data
      : PendingTurnSchema.safeParse(JSON.parse(decoded)).data;
  } catch (_error) {
    return undefined;
  }
}

function enqueueTurn(line) {
  const turn = decodeTurnFrame(line);
  if (turn) enqueuePendingTurn(turn);
}

function enqueuePendingTurn(turn) {
  if (pendingTurns.length >= MAX_PENDING_TURNS) return false;
  pendingTurns.push(turn);
  wakeTurn?.();
  wakeTurn = undefined;
  return true;
}

function nextTurn() {
  if (pendingTurns.length > 0) return Promise.resolve(pendingTurns.shift());
  if (stopping) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    wakeTurn = () => resolve(pendingTurns.shift());
  });
}

function turnOption(turn, id) {
  const value = turn.modelOptions.find((option) => option.id === id)?.value;
  return typeof value === "string" ? value : undefined;
}

function turnStartParams(threadId, turn) {
  const effort = EffortSchema.parse(turnOption(turn, "effort"));
  const serviceTier = ServiceTierSchema.parse(turnOption(turn, "service_tier"));
  return {
    threadId,
    input: [{ type: "text", text: turn.prompt, text_elements: [] }],
    model: turn.model,
    effort,
    serviceTier,
  };
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", enqueueTurn);
input.on("close", () => {
  stdinClosed = true;
  wakeTurn?.();
  wakeTurn = undefined;
});

function stop() {
  if (stopping) return;
  stopping = true;
  input.close();
  wakeTurn?.();
  wakeTurn = undefined;
  child.kill("SIGTERM");
  stopTimer = setTimeout(() => child.kill("SIGKILL"), PROVIDER_STOP_TIMEOUT_MS);
  stopTimer.unref();
}

async function finishTurn(outcome) {
  const hasUnsettledItems = assistantItemsWithDelta.size > 0 ||
    assistantDeltaBuffers.size > 0 ||
    startedToolItems.size > 0 ||
    toolItemsWithOutput.size > 0;
  if (!activeTurn && !hasUnsettledItems) {
    if (outcome === "failed" && terminalEventCount === 0) {
      await persist({ type: "turn.failed" });
      terminalEventCount += 1;
    }
    return;
  }
  activeTurn = false;
  activeNativeTurnId = undefined;
  for (const messageId of assistantItemsWithDelta) {
    await flushAssistantDelta(messageId);
    await persist({ type: "matrix.codex.assistant.completed", messageId });
    assistantItemsWithDelta.delete(messageId);
  }
  for (const toolCallId of startedToolItems) {
    await persist({
      type: "matrix.codex.tool.completed",
      toolCallId,
      outcome: "cancelled",
    });
    startedToolItems.delete(toolCallId);
    toolItemsWithOutput.delete(toolCallId);
  }
  assistantDeltaBuffers.clear();
  toolItemsWithOutput.clear();
  await persist({
    type: outcome === "completed" ? "turn.completed" : outcome === "aborted" ? "turn.aborted" : "turn.failed",
  });
  terminalEventCount += 1;
  activeTurnOutcome?.(outcome);
  activeTurnOutcome = undefined;
}

async function runTurn(threadId, turn) {
  if (activeTurn || activeTurnOutcome) throw new Error("provider_turn_overlap");
  const outcome = new Promise((resolve) => {
    activeTurnOutcome = resolve;
  });
  activeTurn = true;
  try {
    const started = await request("turn/start", turnStartParams(threadId, turn));
    activeNativeTurnId = z.object({
      turn: z.object({ id: NativeReferenceSchema }).passthrough(),
    }).passthrough().parse(started).turn.id;
  } catch (error) {
    activeTurn = false;
    activeNativeTurnId = undefined;
    activeTurnOutcome = undefined;
    throw error;
  }
  return Promise.race([
    outcome,
    childExit.then(async () => {
      const output = await providerOutput;
      if (!output.ok) throw output.error;
      if (!activeTurn) return outcome;
      throw new Error("provider_stopped_during_turn");
    }),
  ]);
}

const providerOutput = consumeProviderOutput(child.stdout).then(
  () => ({ ok: true }),
  (error) => {
    stop();
    return { ok: false, error };
  },
);
const providerErrors = discardProviderErrors(child.stderr).then(
  () => ({ ok: true }),
  (error) => {
    stop();
    return { ok: false, error };
  },
);
process.once("SIGTERM", stop);
process.once("SIGINT", stop);

let exitCode = 0;
try {
  await request("initialize", {
    clientInfo: { name: "matrix-os", title: "Matrix OS", version: "1" },
    capabilities: { experimentalApi: true },
  });
  sendProvider({ method: "initialized", params: {} });
  const threadMethod = config.providerThreadId ? "thread/resume" : "thread/start";
  const started = await request(threadMethod, {
    ...(config.providerThreadId ? { threadId: config.providerThreadId } : {}),
    model: config.model,
    serviceTier: config.serviceTier,
    cwd: process.cwd(),
    approvalPolicy: config.approvalPolicy,
    sandbox: config.sandbox,
    runtimeWorkspaceRoots: config.writableRoots,
    experimentalRawEvents: false,
  });
  nativeThreadId = z.object({ thread: z.object({ id: NativeReferenceSchema }).passthrough() })
    .passthrough().parse(started).thread.id;
  let turn = PendingTurnSchema.parse({
    prompt: config.prompt,
    model: config.model,
    modelOptions: [
      ...(config.effort ? [{ id: "effort", value: config.effort }] : []),
      ...(config.serviceTier ? [{ id: "service_tier", value: config.serviceTier }] : []),
    ],
  });
  while (turn && !stopping) {
    const outcome = await runTurn(nativeThreadId, turn);
    if (outcome === "failed") exitCode = 1;
    const next = await Promise.race([
      nextTurn().then((value) => ({ type: "turn", value })),
      childExit.then((exit) => ({ type: "exit", exit })),
      providerOutput.then((result) => ({ type: "output", result })),
    ]);
    if (next.type === "output") {
      if (!next.result.ok) throw next.result.error;
      if (stdinClosed) {
        stop();
        break;
      }
      throw new Error("provider_transport_closed");
    }
    if (next.type === "exit") {
      if (next.exit.error || next.exit.code !== 0) throw new Error("provider_stopped");
      break;
    }
    turn = next.value;
    if (!turn) stop();
  }
  const exit = await childExit;
  const [outputResult, errorResult] = await Promise.all([providerOutput, providerErrors]);
  if (!outputResult.ok) throw outputResult.error;
  if (!errorResult.ok) throw errorResult.error;
  if (exit.error) throw exit.error;
  await new Promise((resolve) => setTimeout(resolve, SHUTDOWN_REPLAY_GRACE_MS));
  if (activeTurn || terminalEventCount === 0) exitCode = 1;
} catch (_error) {
  exitCode = 1;
  await finishTurn("failed").catch(() => undefined);
  stop();
  await Promise.allSettled([childExit, providerOutput, providerErrors]);
} finally {
  input.close();
  clearInterval(cleanupTimer);
  if (stopTimer) clearTimeout(stopTimer);
  for (const pending of pendingRpc.values()) {
    clearTimeout(pending.timeout);
    pending.reject(new Error("provider_stopped"));
  }
  pendingRpc.clear();
  for (const socket of controlSockets) socket.destroy();
  controlSockets.clear();
  await new Promise((resolve) => controlServer.close(resolve));
  await rm(controlPath, { force: true });
  await eventFile.close();
}
process.exitCode = exitCode;
