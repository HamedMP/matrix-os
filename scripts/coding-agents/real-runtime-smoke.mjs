#!/usr/bin/env node
import { z } from "zod/v4";
import { fileURLToPath } from "node:url";

export const DEFAULT_TIMEOUT_MS = 10_000;
export const MAX_JSON_BYTES = 1024 * 1024;
export const MAX_SUMMARY_COUNT_ASSERTION = 50;
export const MAX_REVIEW_COUNT_ASSERTION = 1000;
export const MAX_REVIEW_PAGES = 20;

const SAFE_SLUG = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const SAFE_ERROR_CODE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const UNSAFE_DISPLAY_TEXT = /(stack trace|\/home\/|\/tmp\/|\/var\/|\.ssh\/|id_rsa|bearer\s+[A-Za-z0-9._-]+|sk-[A-Za-z0-9_-]+)/i;
// Keep local contract regexes aligned with packages/contracts for direct Node execution.
const RUNTIME_ID = /^rt_[A-Za-z0-9_-]{1,128}$/;
const THREAD_ID = /^thread_[A-Za-z0-9_-]{1,128}$/;
const TASK_ID = /^task_[A-Za-z0-9_-]{1,128}$/;
const REVIEW_ID = SAFE_REFERENCE;
const TERMINAL_ID = SAFE_REFERENCE;
const WORKTREE_ID = /^wt_[a-z0-9]{12,40}$/;
const EVENT_ID = /^evt_[A-Za-z0-9_-]{1,128}$/;
const APPROVAL_ID = /^appr_[A-Za-z0-9_-]{1,128}$/;
const REQUEST_ID = /^req_[A-Za-z0-9_-]{1,128}$/;
const CORRELATION_ID = /^corr_[A-Za-z0-9_-]{1,128}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

const RUNTIME_CAPABILITY_IDS = [
  "codingAgentsRuntimeSummary",
  "codingAgentsDesktopWorkspace",
  "codingAgentsMobileWorkspace",
  "codingAgentsThreadCreate",
  "codingAgentsApprovals",
  "codingAgentsReview",
  "codingAgentsPreview",
  "codingAgentsFiles",
  "codingAgentsSourceControl",
  "codingAgentsNativeMobileTerminal",
];

const RuntimeCapabilityIdSchema = z.enum(RUNTIME_CAPABILITY_IDS);

const SafeDisplayStringSchema = z.string()
  .min(1)
  .max(120)
  .refine((value) => !looksInternal(value), "Unsafe display string");

const SafeLongDisplayStringSchema = z.string()
  .min(1)
  .max(2000)
  .refine((value) => !looksInternal(value), "Unsafe display string");

const SafeRequestDescriptionSchema = z.string()
  .min(1)
  .max(600)
  .refine((value) => !looksInternal(value), "Unsafe display string");

const SafeBoundedTextSchema = z.string()
  .min(1)
  .max(4000);

const SafeSetupCommandSchema = z.string()
  .min(1)
  .max(280)
  .refine((value) => !UNSAFE_DISPLAY_TEXT.test(value), "Unsafe setup command");

const ReferenceIdSchema = z.string()
  .min(1)
  .max(160)
  .regex(SAFE_REFERENCE)
  .refine((value) => !value.includes(".."), "Reference cannot contain traversal");

const SafeSetupActionSchema = z.discriminatedUnion("kind", [
  z.object({
    id: z.string().min(1).max(80).regex(SAFE_SLUG),
    kind: z.literal("open_settings"),
    label: SafeDisplayStringSchema,
  }).strict(),
  z.object({
    id: z.string().min(1).max(80).regex(SAFE_SLUG),
    kind: z.literal("foreground_terminal"),
    label: SafeDisplayStringSchema,
    command: SafeSetupCommandSchema,
  }).strict(),
]);

const RuntimeTargetSchema = z.object({
  id: z.string().regex(RUNTIME_ID),
  label: SafeDisplayStringSchema,
  status: z.enum(["available", "degraded", "offline", "unknown"]),
  channel: z.string().min(1).max(40).regex(SAFE_SLUG).optional(),
  ownerHandle: z.string().min(1).max(80).regex(SAFE_SLUG).optional(),
}).strict();

const RuntimeCapabilitySchema = z.object({
  id: RuntimeCapabilityIdSchema,
  enabled: z.boolean(),
  reason: SafeDisplayStringSchema.optional(),
}).strict();

const AgentProviderSummarySchema = z.object({
  id: z.string().min(1).max(80).regex(SAFE_SLUG),
  displayName: SafeDisplayStringSchema,
  kind: z.enum(["claude", "codex", "opencode", "cursor", "custom"]),
  availability: z.enum(["available", "setup_required", "auth_required", "installing", "unavailable", "unknown"]),
  installStatus: z.enum(["installed", "missing", "installing", "failed", "unknown"]),
  authStatus: z.enum(["authenticated", "missing", "expired", "unknown"]),
  supportedModes: z.array(z.enum(["default", "plan", "review", "full_access"])).min(1).max(8),
  defaultMode: z.enum(["default", "plan", "review", "full_access"]),
  defaultModel: SafeDisplayStringSchema.optional(),
  setupActions: z.array(SafeSetupActionSchema).max(6),
  lastCheckedAt: z.string().regex(ISO_DATETIME).optional(),
}).strict().superRefine((value, ctx) => {
  if (!value.supportedModes.includes(value.defaultMode)) {
    ctx.addIssue({ code: "custom", message: "Default mode must be supported", path: ["defaultMode"] });
  }
});

const AgentThreadSummarySchema = z.object({
  id: z.string().regex(THREAD_ID),
  providerId: z.string().min(1).max(80).regex(SAFE_SLUG),
  title: SafeDisplayStringSchema,
  status: z.enum([
    "queued",
    "starting",
    "running",
    "waiting_for_approval",
    "waiting_for_input",
    "completed",
    "failed",
    "aborted",
    "stale",
    "archived",
  ]),
  attention: z.enum(["none", "approval_required", "input_required", "failed", "completed"]).default("none"),
  projectId: ReferenceIdSchema.optional(),
  taskId: z.string().regex(TASK_ID).optional(),
  terminalSessionId: z.string().regex(TERMINAL_ID).optional(),
  eventCursor: ReferenceIdSchema.optional(),
  createdAt: z.string().regex(ISO_DATETIME),
  updatedAt: z.string().regex(ISO_DATETIME),
}).strict();

const TerminalSessionSummarySchema = z.object({
  id: z.string().regex(TERMINAL_ID),
  name: SafeDisplayStringSchema,
  status: z.enum(["starting", "running", "idle", "exited", "stale", "unavailable"]),
  attachable: z.boolean(),
  cwdLabel: SafeDisplayStringSchema.optional(),
  createdAt: z.string().regex(ISO_DATETIME),
  updatedAt: z.string().regex(ISO_DATETIME),
}).strict();

const ReviewSummarySchema = z.object({
  id: z.string().regex(REVIEW_ID),
  projectId: ReferenceIdSchema,
  worktreeId: z.string().regex(WORKTREE_ID),
  status: z.enum([
    "queued",
    "reviewing",
    "implementing",
    "verifying",
    "converged",
    "stalled",
    "failed",
    "failed_parse",
    "stopped",
    "approved",
  ]),
  pullRequestNumber: z.number().int().min(1).max(10_000_000),
  round: z.number().int().min(0).max(100),
  maxRounds: z.number().int().min(1).max(100),
  reviewer: z.string().min(1).max(80).regex(SAFE_SLUG),
  implementer: z.string().min(1).max(80).regex(SAFE_SLUG),
  findings: z.object({
    total: z.number().int().min(0).max(1_000_000),
    high: z.number().int().min(0).max(1_000_000),
    medium: z.number().int().min(0).max(1_000_000),
    low: z.number().int().min(0).max(1_000_000),
  }).strict().optional(),
  safeStatus: SafeDisplayStringSchema.optional(),
  updatedAt: z.string().regex(ISO_DATETIME),
}).strict();

const ProjectSummarySchema = z.object({
  id: ReferenceIdSchema,
  label: SafeDisplayStringSchema,
  status: z.enum(["available", "missing", "stale", "unknown"]).default("unknown"),
  updatedAt: z.string().regex(ISO_DATETIME).optional(),
}).strict();

const PreviewSessionSummarySchema = z.object({
  id: ReferenceIdSchema,
  projectId: ReferenceIdSchema.optional(),
  label: SafeDisplayStringSchema,
  status: z.enum(["starting", "running", "failed", "stopped", "unknown"]),
  origin: z.string().url().max(2048).optional(),
  updatedAt: z.string().regex(ISO_DATETIME).optional(),
}).strict();

const ActivityEventSummarySchema = z.object({
  id: z.string().regex(EVENT_ID),
  kind: z.enum(["thread", "terminal", "provider", "runtime", "review", "preview"]),
  label: SafeDisplayStringSchema,
  occurredAt: z.string().regex(ISO_DATETIME),
}).strict();

const BaseThreadEventSchema = z.object({
  eventId: z.string().regex(EVENT_ID),
  threadId: z.string().regex(THREAD_ID),
  occurredAt: z.string().regex(ISO_DATETIME),
});

const SafeClientErrorSchema = z.object({
  // Thread event errors mirror the shared client error contract; HTTP envelopes use SAFE_ERROR_CODE below.
  code: z.string().min(1).max(80).regex(SAFE_SLUG),
  safeMessage: SafeDisplayStringSchema,
  retryable: z.boolean(),
  recoveryActions: z.array(z.enum([
    "retry",
    "sign_in",
    "select_runtime",
    "open_setup_terminal",
    "resume",
    "start_new_session",
    "return_home",
  ])).max(6).optional(),
}).strict();

const ApprovalPreviewSchema = z.object({
  title: SafeDisplayStringSchema.optional(),
  body: SafeLongDisplayStringSchema.optional(),
  truncated: z.boolean().default(false),
}).strict();

const AgentApprovalRequestSchema = z.object({
  approvalId: z.string().regex(APPROVAL_ID),
  threadId: z.string().regex(THREAD_ID),
  title: SafeDisplayStringSchema,
  safeDescription: SafeRequestDescriptionSchema,
  risk: z.enum(["low", "medium", "high"]),
  actionKind: z.enum(["command", "file_change", "network", "provider", "other"]),
  preview: ApprovalPreviewSchema.optional(),
  allowedDecisions: z.array(z.enum(["approve", "approve_for_session", "decline", "cancel"])).min(1).max(4),
  expiresAt: z.string().regex(ISO_DATETIME).optional(),
  correlationId: z.string().regex(CORRELATION_ID),
}).strict();

const UserInputRequestSchema = z.object({
  requestId: z.string().regex(REQUEST_ID),
  threadId: z.string().regex(THREAD_ID),
  title: SafeDisplayStringSchema,
  safeDescription: SafeRequestDescriptionSchema,
  placeholder: SafeDisplayStringSchema.optional(),
  required: z.boolean().default(true),
  expiresAt: z.string().regex(ISO_DATETIME).optional(),
  correlationId: z.string().regex(CORRELATION_ID),
}).strict();

function safeRelativePathSchema(max = 512) {
  return z.string()
    .min(1)
    .max(max)
    .refine((value) => !value.startsWith("/") && !value.includes("\0"), "Invalid path")
    .refine((value) => !value.split(/[\\/]+/).some((part) => part === "" || part === "." || part === ".."), {
      message: "Path traversal is not allowed",
    });
}

const AgentThreadEventSchema = z.discriminatedUnion("type", [
  BaseThreadEventSchema.extend({
    type: z.literal("thread.created"),
    thread: AgentThreadSummarySchema,
  }).strict(),
  BaseThreadEventSchema.extend({
    type: z.literal("thread.status"),
    status: z.enum([
      "queued",
      "starting",
      "running",
      "waiting_for_approval",
      "waiting_for_input",
      "completed",
      "failed",
      "aborted",
      "stale",
      "archived",
    ]),
  }).strict(),
  BaseThreadEventSchema.extend({
    type: z.literal("assistant.text.delta"),
    messageId: ReferenceIdSchema,
    delta: SafeBoundedTextSchema.max(4000),
  }).strict(),
  BaseThreadEventSchema.extend({
    type: z.literal("assistant.text.completed"),
    messageId: ReferenceIdSchema,
  }).strict(),
  BaseThreadEventSchema.extend({
    type: z.literal("tool.started"),
    toolCallId: ReferenceIdSchema,
    displayName: SafeDisplayStringSchema,
    kind: SafeDisplayStringSchema,
  }).strict(),
  BaseThreadEventSchema.extend({
    type: z.literal("tool.output"),
    toolCallId: ReferenceIdSchema,
    text: SafeBoundedTextSchema,
    truncated: z.boolean().optional(),
  }).strict(),
  BaseThreadEventSchema.extend({
    type: z.literal("tool.completed"),
    toolCallId: ReferenceIdSchema,
    outcome: z.enum(["success", "failed", "cancelled"]),
  }).strict(),
  BaseThreadEventSchema.extend({
    type: z.literal("approval.requested"),
    approval: AgentApprovalRequestSchema,
  }).strict(),
  BaseThreadEventSchema.extend({
    type: z.literal("approval.resolved"),
    approvalId: z.string().regex(APPROVAL_ID),
    decision: z.enum(["approve", "approve_for_session", "decline", "cancel"]),
  }).strict(),
  BaseThreadEventSchema.extend({
    type: z.literal("user_input.requested"),
    request: UserInputRequestSchema,
  }).strict(),
  BaseThreadEventSchema.extend({
    type: z.literal("user_input.answered"),
    requestId: z.string().regex(REQUEST_ID),
    correlationId: z.string().regex(CORRELATION_ID),
  }).strict(),
  BaseThreadEventSchema.extend({
    type: z.literal("file.changed"),
    path: safeRelativePathSchema(),
    changeKind: z.enum(["created", "updated", "deleted", "renamed"]),
  }).strict(),
  BaseThreadEventSchema.extend({
    type: z.literal("review.ready"),
    reviewId: ReferenceIdSchema,
    summary: z.object({
      changedFileCount: z.number().int().min(0).max(10_000),
      additions: z.number().int().min(0).max(1_000_000),
      deletions: z.number().int().min(0).max(1_000_000),
      partial: z.boolean(),
    }).strict(),
  }).strict(),
  BaseThreadEventSchema.extend({
    type: z.literal("terminal.bound"),
    terminalSessionId: z.string().regex(TERMINAL_ID),
  }).strict(),
  BaseThreadEventSchema.extend({
    type: z.literal("thread.error"),
    error: SafeClientErrorSchema,
  }).strict(),
  BaseThreadEventSchema.extend({
    type: z.literal("thread.completed"),
    outcome: z.enum(["completed", "failed", "aborted"]),
  }).strict(),
]);

const ThreadListSchema = boundedListSchema(AgentThreadSummarySchema, 50);
const ReviewListSchema = boundedListSchema(ReviewSummarySchema, 50);
const AgentThreadSnapshotSchema = z.object({
  thread: AgentThreadSummarySchema,
  events: boundedListSchema(AgentThreadEventSchema, 200),
}).strict();

const RuntimeSummarySchema = z.object({
  runtime: RuntimeTargetSchema,
  capabilities: z.array(RuntimeCapabilitySchema).max(32),
  providers: z.array(AgentProviderSummarySchema).max(20),
  projects: boundedListSchema(ProjectSummarySchema, 50),
  activeThreads: ThreadListSchema,
  attentionThreads: ThreadListSchema.default({ items: [], hasMore: false, limit: 20 }),
  terminalSessions: boundedListSchema(TerminalSessionSummarySchema, 50),
  previewSessions: boundedListSchema(PreviewSessionSummarySchema, 50).default({ items: [], hasMore: false, limit: 50 }),
  recentActivity: boundedListSchema(ActivityEventSummarySchema, 100),
  limits: z.object({
    maxPromptBytes: z.number().int().min(1).max(256 * 1024),
    maxAttachmentCount: z.number().int().min(0).max(32),
    maxTerminalInputBytes: z.number().int().min(1).max(256 * 1024),
    maxListItems: z.number().int().min(1).max(200),
  }).strict(),
  serverTime: z.string().regex(ISO_DATETIME),
}).strict();

const NotificationPreferencesEnvelopeSchema = z.object({
  preferences: z.object({
    attentionPush: z.object({
      approval: z.boolean(),
      input: z.boolean(),
      failed: z.boolean(),
      completed: z.boolean().default(true),
    }).strict(),
  }).strict(),
}).strict();

export class SmokeFailure extends Error {
  constructor(checkName, safeMessage, options = {}) {
    super(safeMessage, options.cause ? { cause: options.cause } : undefined);
    this.name = "SmokeFailure";
    this.checkName = checkName;
    this.safeMessage = safeMessage;
    this.status = options.status;
  }
}

export function normalizeRuntimeUrl(rawUrl) {
  const input = String(rawUrl ?? "").trim();
  if (!input) {
    throw new Error("runtime URL is required");
  }
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("runtime URL must use http or https");
  }
  url.search = "";
  url.hash = "";
  if (!url.pathname.endsWith("/")) {
    url.pathname = `${url.pathname}/`;
  }
  return url;
}

export function buildAuthHeaders(token) {
  const normalized = String(token ?? "").trim();
  if (!normalized) {
    throw new Error("runtime token is required");
  }
  return {
    Authorization: `Bearer ${normalized}`,
    Accept: "application/json",
  };
}

export function redactForLog(value) {
  return String(value)
    .replace(/--token(?:=|\s+)[^\s]+/g, "--token [redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [redacted]")
    .replace(/([?&](?:token|auth|authorization|access_token)=)[^&\s]+/gi, "$1[redacted]");
}

export function createSmokeConfig(argv = process.argv.slice(2), env = process.env) {
  const flags = parseArgs(argv);
  const runtimeUrl = normalizeRuntimeUrl(flags.url ?? env.MATRIX_RUNTIME_URL ?? env.MATRIX_CODING_AGENT_SMOKE_URL);
  const token = String(env.MATRIX_RUNTIME_TOKEN ?? env.MATRIX_CODING_AGENT_SMOKE_TOKEN ?? "").trim();
  if (!token) {
    throw new Error("runtime token is required");
  }
  const timeoutMs = flags.timeoutMs ?? env.MATRIX_CODING_AGENT_SMOKE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS;
  const parsedTimeout = Number(timeoutMs);
  if (!Number.isInteger(parsedTimeout) || parsedTimeout < 1000 || parsedTimeout > 60_000) {
    throw new Error("timeout must be an integer between 1000 and 60000 milliseconds");
  }

  return {
    runtimeUrl,
    token,
    timeoutMs: parsedTimeout,
    projectId: normalizeOptionalProjectId(flags.projectId ?? env.MATRIX_CODING_AGENT_SMOKE_PROJECT_ID),
    json: Boolean(flags.json),
    requiredCapabilities: flags.requiredCapabilities ?? [],
    requireReadyProvider: Boolean(flags.requireReadyProvider),
    requireThreadSnapshot: Boolean(flags.requireThreadSnapshot),
    minActiveThreads: flags.minActiveThreads,
    minTerminalSessions: flags.minTerminalSessions,
    minPreviewSessions: flags.minPreviewSessions,
    minReviews: flags.minReviews,
  };
}

export async function runRuntimeSmoke(options) {
  const runtimeUrl = normalizeRuntimeUrl(options.runtimeUrl instanceof URL ? options.runtimeUrl.toString() : options.runtimeUrl);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers = buildAuthHeaders(options.token);
  const projectId = normalizeOptionalProjectId(options.projectId);
  const checks = [];

  const summary = await runCheck({
    name: "runtime summary",
    runtimeUrl,
    path: projectId
      ? `/api/coding-agents/summary?projectId=${encodeURIComponent(projectId)}`
      : "/api/coding-agents/summary",
    headers,
    timeoutMs,
    fetchImpl,
    schema: RuntimeSummarySchema,
    contractName: "Runtime summary",
  });
  checks.push({
    name: "runtime summary",
    status: "passed",
    detail: `${summary.providers.length} providers, ${summary.activeThreads.items.length} active threads, ${summary.terminalSessions.items.length} terminals`,
  });

  const threads = await runCheck({
    name: "thread list",
    runtimeUrl,
    path: "/api/coding-agents/threads",
    headers,
    timeoutMs,
    fetchImpl,
    schema: ThreadListSchema,
    contractName: "Thread list",
  });
  checks.push({
    name: "thread list",
    status: "passed",
    detail: `${threads.items.length} threads`,
  });

  const reviews = await runCheck({
    name: "review list",
    runtimeUrl,
    path: "/api/coding-agents/reviews",
    headers,
    timeoutMs,
    fetchImpl,
    schema: ReviewListSchema,
    contractName: "Review list",
  });
  checks.push({
    name: "review list",
    status: "passed",
    detail: `${reviews.items.length} reviews`,
  });
  const reviewCount = await countReviewsForMinimum({
    initial: reviews,
    minReviews: options.minReviews,
    runtimeUrl,
    headers,
    timeoutMs,
    fetchImpl,
  });
  if (reviewCount > reviews.items.length) {
    checks.push({
      name: "review pagination",
      status: "passed",
      detail: `${reviewCount} reviews checked`,
    });
  }

  await runCheck({
    name: "notification preferences",
    runtimeUrl,
    path: "/api/coding-agents/notification-preferences",
    headers,
    timeoutMs,
    fetchImpl,
    schema: NotificationPreferencesEnvelopeSchema,
    contractName: "Notification preferences",
  });
  checks.push({
    name: "notification preferences",
    status: "passed",
    detail: "owner preferences available",
  });

  const threadId = summary.activeThreads.items[0]?.id ?? summary.attentionThreads.items[0]?.id;
  let checkedThreadSnapshot = false;
  if (options.requireThreadSnapshot && !threadId) {
    throw new SmokeFailure(
      "thread snapshot",
      "thread snapshot unavailable because no active or attention thread is available. Start or select a thread and try again.",
    );
  }
  if (options.requireThreadSnapshot && threadId) {
    await runCheck({
      name: "thread snapshot",
      runtimeUrl,
      path: `/api/coding-agents/threads/${encodeURIComponent(threadId)}`,
      headers,
      timeoutMs,
      fetchImpl,
      schema: AgentThreadSnapshotSchema,
      contractName: "Thread snapshot",
    });
    checkedThreadSnapshot = true;
    checks.push({
      name: "thread snapshot",
      status: "passed",
      detail: "latest thread snapshot available",
    });
  }

  const assertionsChecked = evaluateRequirements({
    summary,
    reviewCount,
    checkedThreadSnapshot,
    request: options,
  });
  if (assertionsChecked > 0) {
    checks.push({
      name: "runtime requirements",
      status: "passed",
      detail: `${assertionsChecked} read-only assertions checked`,
    });
  }

  return { ok: true, checks };
}

async function runCheck({ name, runtimeUrl, path, headers, timeoutMs, fetchImpl, schema, contractName }) {
  const url = new URL(path.replace(/^\/+/, ""), runtimeUrl);
  const response = await fetchJson({ name, url, headers, timeoutMs, fetchImpl });
  const result = schema.safeParse(response);
  if (!result.success) {
    throw new SmokeFailure(name, `${contractName} response did not match the Matrix coding-agent contract.`, {
      cause: result.error,
    });
  }
  return result.data;
}

async function fetchJson({ name, url, headers, timeoutMs, fetchImpl }) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new SmokeFailure(name, `${name} is temporarily unreachable. Check the runtime connection and try again.`, {
      cause: err,
    });
  }

  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BYTES) {
      throw new SmokeFailure(name, `${name} returned too much data. Check runtime limits and try again.`, {
        status: response.status,
      });
    }
  }

  const text = await readBoundedText(response, name);

  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (err) {
    throw new SmokeFailure(name, `${name} returned an invalid response. Check the runtime and try again.`, {
      status: response.status,
      cause: err,
    });
  }

  if (!response.ok) {
    const safeCode = safeErrorCode(body);
    throw new SmokeFailure(
      name,
      safeCode
        ? `${name} failed with ${safeCode}. Resolve the runtime issue and try again.`
        : `${name} failed. Resolve the runtime issue and try again.`,
      { status: response.status },
    );
  }

  return body;
}

function boundedListSchema(itemSchema, maxItems) {
  return z.object({
    items: z.array(itemSchema).max(maxItems),
    hasMore: z.boolean(),
    nextCursor: z.string().min(1).max(200).optional(),
    limit: z.number().int().min(1).max(maxItems),
  }).strict();
}

function parseArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      flags.json = true;
      continue;
    }
    if (arg === "--url") {
      flags.url = argv[++index];
      continue;
    }
    if (arg === "--token" || arg.startsWith("--token=")) {
      throw new Error("Use MATRIX_RUNTIME_TOKEN or MATRIX_CODING_AGENT_SMOKE_TOKEN instead of --token");
    }
    if (arg === "--project-id") {
      flags.projectId = argv[++index];
      continue;
    }
    if (arg === "--require-capability") {
      const result = RuntimeCapabilityIdSchema.safeParse(argv[++index]);
      if (!result.success) {
        throw new Error("Invalid required capability");
      }
      flags.requiredCapabilities = [...(flags.requiredCapabilities ?? []), result.data];
      continue;
    }
    if (arg === "--require-ready-provider") {
      flags.requireReadyProvider = true;
      continue;
    }
    if (arg === "--require-thread-snapshot") {
      flags.requireThreadSnapshot = true;
      continue;
    }
    if (arg === "--min-active-threads") {
      flags.minActiveThreads = parseSummaryMinimumCount(argv[++index], "min-active-threads");
      continue;
    }
    if (arg === "--min-terminal-sessions") {
      flags.minTerminalSessions = parseSummaryMinimumCount(argv[++index], "min-terminal-sessions");
      continue;
    }
    if (arg === "--min-preview-sessions") {
      flags.minPreviewSessions = parseSummaryMinimumCount(argv[++index], "min-preview-sessions");
      continue;
    }
    if (arg === "--min-reviews") {
      flags.minReviews = parseMinimumCount(argv[++index], "min-reviews");
      continue;
    }
    if (arg === "--timeout-ms") {
      flags.timeoutMs = argv[++index];
      continue;
    }
    throw new Error("Unknown argument");
  }
  return flags;
}

function normalizeOptionalProjectId(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const result = ReferenceIdSchema.safeParse(String(value).trim());
  if (!result.success) {
    throw new Error("project id is invalid");
  }
  return result.data;
}

function parseMinimumCount(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_REVIEW_COUNT_ASSERTION) {
    throw new Error(`${label} must be a positive integer up to ${MAX_REVIEW_COUNT_ASSERTION}`);
  }
  return parsed;
}

function parseSummaryMinimumCount(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_SUMMARY_COUNT_ASSERTION) {
    throw new Error(`${label} must be a positive integer up to ${MAX_SUMMARY_COUNT_ASSERTION}`);
  }
  return parsed;
}

function isReadyProvider(provider) {
  return provider.availability === "available" &&
    provider.installStatus === "installed" &&
    provider.authStatus === "authenticated";
}

function evaluateRequirements({ summary, reviewCount, checkedThreadSnapshot, request }) {
  let checked = 0;
  const fail = () => {
    throw new SmokeFailure(
      "runtime requirements",
      "runtime requirements unavailable. Refresh runtime state and try again.",
    );
  };
  const capabilities = new Map(summary.capabilities.map((capability) => [capability.id, capability.enabled]));

  for (const capabilityId of request.requiredCapabilities ?? []) {
    checked += 1;
    if (capabilities.get(capabilityId) !== true) fail();
  }

  if (request.requireReadyProvider) {
    checked += 1;
    if (!summary.providers.some(isReadyProvider)) fail();
  }

  if (request.requireThreadSnapshot) {
    checked += 1;
    if (!checkedThreadSnapshot) fail();
  }

  checked += assertMinimum(summary.activeThreads.items.length, request.minActiveThreads, fail);
  checked += assertMinimum(summary.terminalSessions.items.length, request.minTerminalSessions, fail);
  checked += assertMinimum(summary.previewSessions.items.length, request.minPreviewSessions, fail);
  checked += assertMinimum(reviewCount, request.minReviews, fail);

  return checked;
}

function assertMinimum(actual, expected, fail) {
  if (expected === undefined) return 0;
  if (actual < expected) fail();
  return 1;
}

async function countReviewsForMinimum({ initial, minReviews, runtimeUrl, headers, timeoutMs, fetchImpl }) {
  let count = initial.items.length;
  let hasMore = initial.hasMore;
  let nextCursor = initial.nextCursor;
  let pagesRead = 1;

  while (
    minReviews !== undefined &&
    count < minReviews &&
    hasMore &&
    nextCursor &&
    pagesRead < MAX_REVIEW_PAGES
  ) {
    const page = await runCheck({
      name: "review pagination",
      runtimeUrl,
      path: `/api/coding-agents/reviews?cursor=${encodeURIComponent(nextCursor)}`,
      headers,
      timeoutMs,
      fetchImpl,
      schema: ReviewListSchema,
      contractName: "Review list",
    });
    count += page.items.length;
    hasMore = page.hasMore;
    nextCursor = page.nextCursor;
    pagesRead += 1;
  }

  return count;
}

async function readBoundedText(response, name) {
  if (!response.body || typeof response.body.getReader !== "function") {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_JSON_BYTES) {
      throw new SmokeFailure(name, `${name} returned too much data. Check runtime limits and try again.`, {
        status: response.status,
      });
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_JSON_BYTES) {
        await reader.cancel("response too large").catch(handleStreamCancelError);
        throw new SmokeFailure(name, `${name} returned too much data. Check runtime limits and try again.`, {
          status: response.status,
        });
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (err) {
    if (err instanceof SmokeFailure) throw err;
    throw new SmokeFailure(name, `${name} returned an invalid response. Check the runtime and try again.`, {
      status: response.status,
      cause: err,
    });
  }

  return text;
}

function handleStreamCancelError() {
  if (process.env.MATRIX_CODING_AGENT_SMOKE_DEBUG === "1") {
    console.error("response stream cancel failed");
  }
}

function safeErrorCode(body) {
  const code = body?.error?.code;
  return typeof code === "string" && SAFE_ERROR_CODE.test(code) ? code : null;
}

function looksInternal(value) {
  return /(?:sk-[A-Za-z0-9_-]{8,}|Bearer\s+|\/home\/|\/opt\/|postgres|stack trace|at\s+\w+\s+\(|\d{1,3}(?:\.\d{1,3}){3})/i.test(value);
}

function formatText(result) {
  return result.checks.map((check) => `ok ${check.name}: ${check.detail}`).join("\n");
}

async function main() {
  try {
    const config = createSmokeConfig();
    const result = await runRuntimeSmoke(config);
    if (config.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatText(result));
    }
  } catch (err) {
    if (err instanceof SmokeFailure) {
      console.error(redactForLog(`${err.checkName}: ${err.safeMessage}`));
      process.exitCode = 1;
      return;
    }
    console.error(redactForLog(err instanceof Error ? err.message : String(err)));
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
